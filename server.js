var WebTorrent = require('webtorrent')
var parseTorrent = require('parse-torrent')

module.exports = WebTorrentRemoteServer

// Runs WebTorrent.
// Connects to trackers, the DHT, BitTorrent peers, and WebTorrent peers.
// Controlled by one or more WebTorrentRemoteClients.
// - send is a function (message) { ... }
//   Must deliver them message to the WebTorrentRemoteClient
//   If there is more than one client, you must check message.clientKey
// - options is passed to the WebTorrent varructor
function WebTorrentRemoteServer (send, options) {
  this._send = send
  this._options = options || {}
  this._webtorrent = null
  this._clients = {}
  this._torrents = []

  var updateInterval = this._options.updateInterval
  if (updateInterval === undefined) updateInterval = 1000
  if (updateInterval) setInterval(sendUpdates.bind(null, this), updateInterval)
}

// Returns the underlying WebTorrent object, lazily creating it if needed
WebTorrentRemoteServer.prototype.webtorrent = function () {
  if (!this._webtorrent) {
    this._webtorrent = new WebTorrent(this._options)
    addWebTorrentEvents(this)
  }
  return this._webtorrent
}

// Receives a message from the WebTorrentRemoteClient
// Message contains {clientKey, type, ...}
WebTorrentRemoteServer.prototype.receive = function (message) {
  var clientKey = message.clientKey
  if (!this._clients[clientKey]) {
    if (this._options.trace) console.log('adding  client, clientKey: ' + clientKey)
    this._clients[clientKey] = {
      clientKey: clientKey,
      heartbeat: new Date().getTime()
    }
  }
  switch (message.type) {
    case 'subscribe':
      return handleSubscribe(this, message)
    case 'add-torrent':
      return handleAddTorrent(this, message)
    case 'create-server':
      return handleCreateServer(this, message)
    case 'heartbeat':
      return handleHeartbeat(this, message)
    case 'destroy':
      return handleDestroy(this, message)
    default:
      console.error('ignoring unknown message type: ' + JSON.stringify(message))
  }
}

// Event handlers for the whole WebTorrent instance
function addWebTorrentEvents (server) {
  server._webtorrent.on('warning', function (e) { sendError(server, null, e, 'warning') })
  server._webtorrent.on('error', function (e) { sendError(server, null, e, 'error') })
}

// Event handlers for individual torrents
function addTorrentEvents (server, torrent) {
  torrent.on('infohash', function () { sendInfo(server, torrent, 'infohash') })
  torrent.on('metadata', function () { sendInfo(server, torrent, 'metadata') })
  torrent.on('download', function () { sendProgress(server, torrent, 'download') })
  torrent.on('upload', function () { sendProgress(server, torrent, 'upload') })
  torrent.on('done', function () { sendProgress(server, torrent, 'done') })
  torrent.on('warning', function (e) { sendError(server, torrent, e, 'warning') })
  torrent.on('error', function (e) { sendError(server, torrent, e, 'error') })
}

// Subscribe does NOT create a new torrent or join a new swarm
// If message.torrentID is missing, it emits 'torrent-subscribed' with {torrent: null}
// If the webtorrent instance hasn't been created at all yet, subscribe won't create it
function handleSubscribe (server, message) {
  var wt = server._webtorrent // Don't create the webtorrent instance
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey
  var torrentID = message.torrentID

  // See if we've already joined this swarm
  var infohash = parseTorrent(torrentID).infoHash
  var torrent = wt && wt.torrents.find(function (t) { return t.infoHash === infohash })

  // If so, listen for updates
  if (torrent) torrent.clients.push({clientKey: clientKey, torrentKey: torrentKey})

  // Either way, respond
  sendSubscribed(server, torrent, clientKey, torrentKey)
}

// Emits the 'torrent-subscribed' event
function sendSubscribed (server, torrent, clientKey, torrentKey) {
  var response = {
    type: 'torrent-subscribed',
    torrent: null,
    clientKey: clientKey,
    torrentKey: torrentKey
  }

  if (torrent) {
    var infoMessage = getInfoMessage(server, torrent, '')
    var progressMessage = getProgressMessage(server, torrent, '')
    response.torrent = Object.assign(infoMessage.torrent, progressMessage.torrent)
  }

  server._send(response)
}

function handleAddTorrent (server, message) {
  var wt = server.webtorrent()

  // First, see if we've already joined this swarm
  var parsed = parseTorrent(message.torrentID)
  var infohash = parsed.infoHash
  var torrent = wt.torrents.find(function (t) { return t.infoHash === infohash })

  // If not, join the swarm
  if (!torrent) {
    if (server._options.trace) console.log('joining swarm: ' + infohash + ' ' + (parsed.name || ''))
    torrent = wt.add(message.torrentID, message.options)
    torrent.clients = []
    server._torrents.push(torrent)
    addTorrentEvents(server, torrent)
  }

  // Either way, subscribe this client to future updates for this swarm
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey
  torrent.clients.push({clientKey: clientKey, torrentKey: torrentKey})

  // If we want a server, create a server and wait for it to start listening
  var respond = function () { sendSubscribed(server, torrent, clientKey, torrentKey) }
  if (message.options.server) createServer(torrent, message.server, respond)
  else respond()
}

function handleCreateServer (server, message) {
  var clientKey = message.clientKey
  var torrentKey = message.torrentKey
  var torrent = getTorrentByKey(server, torrentKey)
  if (!torrent) return
  createServer(torrent, message.options, function () {
    var serverURL = torrent.serverURL
    server._send({
      clientKey: clientKey,
      torrentKey: torrentKey,
      serverURL: serverURL,
      type: 'server-ready'
    })
  })
}

function createServer (torrent, options, callback) {
  if (torrent.serverURL) {
    // Server already exists. Call back right away
    callback()
  } else if (torrent.pendingServerCallbacks) {
    // Server pending
    // listen() has already been called, but the 'listening' event hasn't fired yet
    torrent.pendingServerCallbacks.push(callback)
  } else {
    // Server does not yet exist. Create it, then notify everyone who asked for it
    torrent.pendingServerCallbacks = [callback]
    torrent.server = torrent.createServer(options)
    torrent.server.listen(function () {
      var addr = torrent.server.address()
      torrent.serverURL = 'http://localhost:' + addr.port
      torrent.pendingServerCallbacks.forEach(function (cb) { cb() })
      delete torrent.pendingServerCallbacks
    })
  }
}

function handleHeartbeat (server, message) {
  var client = server._clients[message.clientKey]
  if (!client) return console.error('skipping heartbeat for unknown clientKey ' + message.clientKey)
  client.heartbeat = new Date().getTime()
}

// Removes a client from all torrents
// If the torrent has no clients left, destroys the torrent
function handleDestroy (server, message) {
  var clientKey = message.clientKey
  var options = message.options
  if (server._options.trace) console.log('destroying client ' + clientKey)
  var kill = function () { killClients(server, [clientKey]) }
  if (options && options.delay) setTimeout(kill, options.delay)
  else kill()
}

function sendInfo (server, torrent, type) {
  var message = getInfoMessage(server, torrent, type)
  sendToTorrentClients(server, torrent, message)
}

function sendProgress (server, torrent, type) {
  var message = getProgressMessage(server, torrent, type)
  sendToTorrentClients(server, torrent, message)
}

function getInfoMessage (server, torrent, type) {
  return {
    type: type,
    torrent: {
      name: torrent.name,
      infohash: torrent.infoHash,
      length: torrent.length,
      serverURL: torrent.serverURL,
      files: (torrent.files || []).map(function (file) {
        return {
          name: file.name,
          length: file.length
        }
      })
    }
  }
}

function getProgressMessage (server, torrent, type) {
  return {
    type: type,
    torrent: {
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
      length: torrent.length,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      ratio: torrent.ratio,
      numPeers: torrent.numPeers,
      timeRemaining: torrent.timeRemaining
    }
  }
}

function sendError (server, torrent, e, type) {
  var message = {
    type: type, // 'warning' or 'error'
    error: {message: e.message, stack: e.stack}
  }
  if (torrent) sendToTorrentClients(server, torrent, message)
  else sendToAllClients(server, message)
}

function sendUpdates (server) {
  var heartbeatTimeout = server._options.heartbeatTimeout
  if (heartbeatTimeout == null) heartbeatTimeout = 30000
  if (heartbeatTimeout > 0) removeDeadClients(server, heartbeatTimeout)
  server._torrents.forEach(function (torrent) {
    sendProgress(server, torrent, 'update')
  })
}

function removeDeadClients (server, heartbeatTimeout) {
  var now = new Date().getTime()
  var clientKeys = []
  for (var clientKey in server._clients) {
    var client = server._clients[clientKey]
    if (now - client.heartbeat <= heartbeatTimeout) continue
    if (server._options.trace) console.log('torrent client died, clientKey: ' + clientKey)
    clientKeys.push(clientKey)
  }
  killClients(server, clientKeys)
}

function killClients (server, clientKeys) {
  if (!clientKeys || clientKeys.length === 0) return
  var trace = server._options.trace

  // Remove clients
  var deadClientKeys = {}
  clientKeys.forEach(function (clientKey) {
    delete server._clients[clientKey]
    deadClientKeys[clientKey] = true
  })

  // Remove clients from torrents
  // If a torrent has no clients left, kill the torrent
  server._torrents.forEach(function (torrent) {
    torrent.clients = torrent.clients.filter(function (c) { return !deadClientKeys[c.clientKey] })
    if (torrent.clients.length > 0) return
    torrent.destroy()
    if (trace) console.log('torrent destroyed, all clients died: ' + torrent.name)
  })

  // Remove torrents. If the last torrent is gone, kill the whole WebTorrent instance
  server._torrents = server._torrents.filter(function (t) { return !t.destroyed })
  if (server._torrents.length > 0 || !server._webtorrent) return
  server._webtorrent.destroy()
  server._webtorrent = null
  if (trace) console.log('torrent instance destroyed, all torrents gone')
}

function sendToTorrentClients (server, torrent, message) {
  torrent.clients.forEach(function (client) {
    var clientMessage = Object.assign({}, message, client)
    server._send(clientMessage)
  })
}

function sendToAllClients (server, message) {
  for (var clientKey in server._clients) {
    var clientMessage = Object.assign({}, message, {clientKey: clientKey})
    server._send(clientMessage)
  }
}

function getTorrentByKey (server, torrentKey) {
  var torrent = server.webtorrent().torrents.find(function (t) { return hasTorrentKey(t, torrentKey) })
  if (!torrent) {
    var message = 'missing torrentKey: ' + torrentKey
    sendError(server, null, {message: message}, 'warning')
  }
  return torrent
}

// Each torrent corresponds to *one or more* torrentKeys
// That's because clients generate torrentKeys independently, and we might have two clients that
// both added a torrent with the same infohash. (In that case, two RemoteTorrent objects correspond
// to the same WebTorrent torrent object.)
function hasTorrentKey (torrent, torrentKey) {
  return torrent.clients.some(function (c) { return c.torrentKey === torrentKey })
}
