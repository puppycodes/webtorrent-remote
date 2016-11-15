const WebTorrent = require('webtorrent')
const parseTorrent = require('parse-torrent')

// Runs WebTorrent.
// Connects to trackers, the DHT, BitTorrent peers, and WebTorrent peers.
// Controlled by one or more WebTorrentRemoteClients.
// - send is a function (message) { ... }
//   Must deliver them message to the WebTorrentRemoteClient
//   If there is more than one client, you must check message.clientKey
// - options is passed to the WebTorrent constructor
module.exports = class WebTorrentRemoteServer {
  constructor (send, options) {
    this._send = send
    this._options = options || {}
    this._webtorrent = null
    this._clients = {}
    this._torrents = []
    let updateInterval = this._options.updateInterval
    if (updateInterval === undefined) updateInterval = 1000
    if (updateInterval) setInterval(() => sendUpdates(this), updateInterval)
  }

  // Returns the underlying WebTorrent object, lazily creating it if needed
  webtorrent () {
    if (!this._webtorrent) {
      this._webtorrent = new WebTorrent(this._options)
      addWebTorrentEvents(this)
    }
    return this._webtorrent
  }

  // Receives a message from the WebTorrentRemoteClient
  // Message contains {clientKey, type, ...}
  receive (message) {
    const {clientKey} = message
    if (!this._clients[clientKey]) {
      this._clients[clientKey] = {
        clientKey,
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
      default:
        console.error('ignoring unknown message type: ' + JSON.stringify(message))
    }
  }
}

// Event handlers for the whole WebTorrent instance
function addWebTorrentEvents (server) {
  server._webtorrent.on('warning', (e) => sendError(server, null, e, 'warning'))
  server._webtorrent.on('error', (e) => sendError(server, null, e, 'error'))
}

// Event handlers for individual torrents
function addTorrentEvents (server, torrent) {
  torrent.on('infohash', () => sendInfo(server, torrent, 'infohash'))
  torrent.on('metadata', () => sendInfo(server, torrent, 'metadata'))
  torrent.on('download', () => sendProgress(server, torrent, 'download'))
  torrent.on('upload', () => sendProgress(server, torrent, 'upload'))
  torrent.on('done', () => sendProgress(server, torrent, 'done'))
  torrent.on('warning', (e) => sendError(server, torrent, e, 'warning'))
  torrent.on('error', (e) => sendError(server, torrent, e, 'error'))
}

// Subscribe does NOT create a new torrent or join a new swarm
// If message.torrentID is missing, it emits 'torrent-subscribed' with {torrent: null}
// If the webtorrent instance hasn't been created at all yet, subscribe won't create it
function handleSubscribe (server, message) {
  const wt = server._webtorrent // Don't create the webtorrent instance
  const {clientKey, torrentKey} = message
  const response = {
    type: 'torrent-subscribed',
    torrent: null,
    clientKey,
    torrentKey
  }

  // See if we've already joined this swarm
  const infohash = parseTorrent(message.torrentID).infoHash
  let torrent = wt && wt.torrents.find((t) => t.infoHash === infohash)
  if (torrent) {
    Object.assign(response, getInfoMessage(server, torrent, response.type))
    addClient(torrent, clientKey, torrentKey)
  }

  server._send(response)
}

function handleAddTorrent (server, message) {
  const wt = server.webtorrent()
  const {clientKey, torrentKey} = message

  // First, see if we've already joined this swarm
  const infohash = parseTorrent(message.torrentID).infoHash
  let torrent = wt.torrents.find((t) => t.infoHash === infohash)

  if (torrent) {
    // If so, send the `infohash` and `metadata` events and a progress update right away
    const keys = {clientKey, torrentKey}
    server._send(Object.assign(getInfoMessage(server, torrent, 'infohash'), keys))
    server._send(Object.assign(getInfoMessage(server, torrent, 'metadata'), keys))
    const progressType = torrent.downloaded === torrent.length ? 'done' : 'update'
    server._send(Object.assign(getProgressMessage(server, torrent, progressType), keys))
  } else {
    // Otherwise, join the swarm
    torrent = wt.add(message.torrentID, message.options)
    torrent.clients = []
    server._torrents.push(torrent)
    addTorrentEvents(server, torrent)
  }

  // Either way, subscribe this client to future updates for this swarm
  addClient(torrent, clientKey, torrentKey)
}

function handleCreateServer (server, message) {
  const {clientKey, torrentKey} = message
  const torrent = getTorrentByKey(server, torrentKey)
  let {serverURL} = torrent
  if (serverURL) {
    // Server already exists. Notify the caller right away
    server._send({clientKey, torrentKey, serverURL, type: 'server-ready'})
  } else if (torrent.pendingHttpClients) {
    // Server pending
    // listen() has already been called, but the 'listening' event hasn't fired yet
    torrent.pendingHttpClients.push({clientKey, torrentKey})
  } else {
    // Server does not yet exist. Create it, then notify everyone who asked for it
    torrent.pendingHttpClients = [{clientKey, torrentKey}]
    torrent.server = torrent.createServer(message.options)
    torrent.server.listen(function () {
      const addr = torrent.server.address()
      serverURL = torrent.serverURL = 'http://localhost:' + addr.port
      torrent.pendingHttpClients.forEach(function ({clientKey, torrentKey}) {
        server._send({clientKey, torrentKey, serverURL, type: 'server-ready'})
      })
      delete torrent.pendingHttpClients
    })
  }
}

function handleHeartbeat (server, message) {
  const client = server._clients[message.clientKey]
  if (!client) return console.error('skipping heartbeat for unknown clientKey ' + message.clientKey)
  client.heartbeat = new Date().getTime()
}

function addClient (torrent, clientKey, torrentKey) {
  // Subscribe this client to future updates for this swarm
  torrent.clients.push({clientKey, torrentKey})
}

function sendInfo (server, torrent, type) {
  const message = getInfoMessage(server, torrent, type)
  sendToTorrentClients(server, torrent, message)
}

function sendProgress (server, torrent, type) {
  const message = getProgressMessage(server, torrent, type)
  sendToTorrentClients(server, torrent, message)
}

function getInfoMessage (server, torrent, type) {
  return {
    type: type,
    torrent: {
      key: torrent.key,
      name: torrent.name,
      infohash: torrent.infoHash,
      length: torrent.length,
      serverURL: torrent.serverURL,
      files: (torrent.files || []).map((file) => ({
        name: file.name,
        length: file.length
      }))
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
  const message = {
    type: type, // 'warning' or 'error'
    error: {message: e.message, stack: e.stack}
  }
  if (torrent) sendToTorrentClients(server, torrent, message)
  else sendToAllClients(server, message)
}

function sendUpdates (server) {
  const heartbeatTimeout = server._options.heartbeatTimeout
  if (heartbeatTimeout > 0) removeDeadClients(server, heartbeatTimeout)
  server._torrents.forEach(function (torrent) {
    sendProgress(server, torrent, 'update')
  })
}

function removeDeadClients (server, heartbeatTimeout) {
  const now = new Date().getTime()
  const isDead = (client) => now - client.heartbeat > heartbeatTimeout
  const deadClientKeys = {}
  for (const clientKey in server._clients) {
    const client = server._clients[clientKey]
    if (!isDead(client)) continue
    console.log('torrent client died, clientKey: ' + clientKey)
    deadClientKeys[clientKey] = true
    delete server._clients[clientKey]
  }
  if (Object.keys(deadClientKeys).length === 0) return

  // Remove listeners from torrents
  // If a torrent has no listeners left, kill the torrent
  server._torrents.forEach((torrent) => {
    torrent.clients = torrent.clients.filter((c) => !deadClientKeys[c.clientKey])
    if (torrent.clients.length > 0) return
    torrent.destroy()
    console.log('torrent destoyed, all clients died: ' + torrent.name + ' / ' + torrent.key)
  })

  // Remove torrents. If the last torrent is gone, kill the client
  server._torrents = server._torrents.filter((t) => !t.destroyed)
  if (server._torrents.length > 0 || !server._webtorrent) return
  server._webtorrent.destroy()
  server._webtorrent = null
  console.log('torrent instance destroyed, all torrents gone')
}

function sendToTorrentClients (server, torrent, message) {
  torrent.clients.forEach(function (client) {
    const clientMessage = Object.assign({}, message, client)
    server._send(clientMessage)
  })
}

function sendToAllClients (server, message) {
  for (const clientKey in server._clients) {
    const clientMessage = Object.assign({}, message, {clientKey})
    server._send(clientMessage)
  }
}

function getTorrentByKey (server, torrentKey) {
  const torrent = server.webtorrent().torrents.find((t) => hasTorrentKey(t, torrentKey))
  if (!torrent) throw new Error('Missing torrentKey: ' + torrentKey)
  return torrent
}

// Each torrent corresponds to *one or more* torrentKeys
// That's because clients generate torrentKeys independently, and we might have two clients that
// both added a torrent with the same infohash. (In that case, two RemoteTorrent objects correspond
// to the same WebTorrent torrent object.)
function hasTorrentKey (torrent, torrentKey) {
  return torrent.clients.some((c) => c.torrentKey === torrentKey)
}