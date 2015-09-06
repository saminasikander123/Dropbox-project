let fs = require('fs')
let path = require('path')
let express = require('express')
let morgan = require('morgan')
let nodeify = require('bluebird-nodeify')
let mime = require('mime-types')
let rimraf = require('rimraf')
let mkdirp = require('mkdirp')
let bluebird = require('bluebird')
let archiver = require('archiver')
let argv = require('yargs').argv
let chokidar = require('chokidar')
let net = require('net')
let JsonSocket = require('json-socket')

require('longjohn')
require('songbird')

const NODE_ENV = process.env.NODE_ENV || 'development'
const PORT = process.env.PORT || 8000
const ROOT_DIR = path.resolve(argv.dir || process.cwd())
const TCP_PORT = 8002

let app = express()

if (NODE_ENV === 'development') {
    app.use(morgan('dev'))
}

app.listen(PORT, () => console.log(`LISTENING @ http://127.0.0.1:${PORT}. Root dir: ${ROOT_DIR}`))

// TCP functionality added here

let clients = []

var port = 8001
var server = net.createServer()
server.listen(port)
server.on('connection', (socket) => {
    console.log("Connection: " + socket.remoteAddress + ":" + socket.remotePort)
    socket = new JsonSocket(socket)
    clients.push(socket)

    socket.on('message', (message) => {
        console.log('Message: ' + message)
    })

    socket.on('end', () => {
        console.log("End connection")
        clients.splice(clients.indexOf(socket), 1)
    })
})

async function sendMessage(message) {
    clients.forEach((client) => {
        client.sendMessage(message)
    })
}

chokidar.watch(ROOT_DIR, {ignored: /[\/\\]\./, ignoreInitial: true})
        .on('add', (path) => { sendMessage({"action": "create", "path": path.replace(ROOT_DIR, ""),
                                            "type": "file", "updated": (new Date).getTime()}) })
        .on('change', (path) => { sendMessage({"action": "update", "path": path.replace(ROOT_DIR, ""),
                                               "type": "file", "updated": (new Date).getTime()}) })
        .on('unlink', (path) => { sendMessage({"action": "delete", "path": path.replace(ROOT_DIR, ""),
                                               "type": "file", "updated": (new Date).getTime()}) })
        .on('addDir', (path) => { sendMessage({"action": "create", "path": path.replace(ROOT_DIR, ""),
                                               "type": "dir", "updated": (new Date).getTime()}) })
        .on('unlinkDir', (path) => { sendMessage({"action": "delete", "path": path.replace(ROOT_DIR, ""),
                                                  "type": "dir", "updated": (new Date).getTime()}) })

app.get('*', setFileMeta, sendHeaders, (req, res) => {
  if (!req.stat) {
    return res.send(400, 'Invalid path')
  }
  if (res.body) {
    if (req.accepts(['*/*', 'application/json'])) {
      res.setHeader("Content-Length", res.body.length)
      res.json(res.body)
      return
    }
    if (req.accepts('application/x-gtar')) {
        let archive = archiver('tar')
        archive.pipe(res);
        archive.bulk([
            { expand: true, cwd: req.filePath, src: ['**']}
        ])
        archive.finalize()
        archive.on('close', function() {
            res.setHeader("Content-Length", archive.pointer())
        });
        res.setHeader("Content-Type", 'application/x-gtar')
        return
    }  // header contains x-gtar
  }  // if res.body

  fs.createReadStream(req.filePath).pipe(res)
})  // app.get

app.head('*', setFileMeta, sendHeaders, (req, res) => res.end())

/* function setFilePath(url) {
    return FilePath
} */

app.delete('*', setFileMeta, (req, res, next) => {
  async () => {
    if (!req.stat) {
      return res.send(400, 'Invalid Path')
    }
    // let stat = fs.promise.stat(req.filePath)
    // if (req.stat && req.stat.isDirectory()) {
    if (req.stat.isDirectory()) {
      await rimraf.promise(req.filePath)
      sendMessage({"action": "delete", "path": req.filePath.replace(ROOT_DIR, ""),
             "type": "dir", "updated": (new Date).getTime()})
    } else {
      // console.log(`filePath = ${req.filePath}`)
      await fs.promise.unlink(req.filePath)
      sendMessage({"action": "delete", "path": req.filePath.replace(ROOT_DIR, ""),
             "type": "file", "updated": (new Date).getTime()})
    }
    res.end()
  }().catch(next)
})

app.put('*', setFileMeta, setDirDetails, (req, res, next) => {
  async () => {
    // if (req.stat) return res.send(405, 'File exists')
    // express deprecated res.send(status, body): Use res.status(status).send(body) instead index.js:126:28
    if (req.stat) {
      // return res.status(405).send('File exists')
      return res.send(405, 'File exists')
    }
    await mkdirp.promise(req.dirPath)
    // if (!req.isDir) req.pipe(fs.createReadStream(req.filePath))  - gives error
    //fs.createReadStream(req.filePath).pipe(res)
    if (!req.isDir) {
      req.pipe(fs.createWriteStream(req.filePath))
      sendMessage({"action": "update", "path": req.filePath.replace(ROOT_DIR, ""),
            "type": "file", "updated": (new Date).getTime()})
    }
    res.end()
  }().catch(next)
})

app.post('*', setFileMeta, setDirDetails, (req, res, next) => {
  async () => {
    // if (!req.stat) return res.send(405, 'File does not exist')
    if (!req.stat) {
      // return res.status(405).send('File does not exist')
      return res.send(405, 'File does not exist')
    }
    // if (req.isDir) return res.send(405, 'Path is a directory')
    if (req.isDir) {
      // return res.status(405).send('Path is a directory')
      return res.send(405, 'Path is a directory')
    }
    //await mkdirp.promise(req.dirPath)
    // if (!req.isDir) req.pipe(fs.createReadStream(req.filePath))  - gives error
    //fs.createReadStream(req.filePath).pipe(res)
    // if (!req.isDir) req.pipe(fs.createWriteStream(req.filePath))
    if (req.stat) {
      await fs.promise.truncate(req.filePath, 0)
    }
    req.pipe(fs.createWriteStream(req.filePath))
    sendMessage({"action": "update", "path": req.filePath.replace(ROOT_DIR, ""),
             "type": "file", "updated": (new Date).getTime()})
    res.end()
  }().catch(next)
})

function setDirDetails(req, res, next) {
  let filePath = req.filePath
  // let endswithSlash = filePath.charAt(filePath.length-1) === '/'
  let endswithSlash = filePath.charAt(filePath.length-1) === path.sep
  //require
  let hasExt = path.extname(filePath) !== ''
  // let isDir = enswithSlash || !hasExt
  //let dirPath = isDir ? filePath : path.dirname(filePath)
  req.isDir = endswithSlash || !hasExt
  req.dirPath = req.isDir ? filePath : path.dirname(filePath)
  next()
}

function setFileMeta(req, res, next) {
  req.filePath = path.resolve(path.join(ROOT_DIR, req.url))
  // let filePath = path.resolve(path.join(ROOT_DIR, req.url))
  // req.filePath = filePath
  // if (filePath.indexOf(ROOT_DIR) !== 0) {
  // Testing
  // if (req.filePath.indexOf(ROOT_DIR) !== 0) {
  if (req.filePath.indexOf(ROOT_DIR) != 0) {
    // res.send(400, 'Invalid path')
    // express deprecated res.send(status, body): Use res.status(status).send(body) instead index.js:127:51
    // res.status(400).send('Invalid path')
    res.send(400, 'Invalid path')
    return
  }
  // fs.stat(filePath, next)
  fs.promise.stat(req.filePath)
    // .then(stat => req.stat = stat)
    // .catch(() => req.stat = null)
    .then(stat => req.stat = stat, () => req.stat = null)
    .nodeify(next)
}

function sendHeaders(req, res, next) {
  nodeify(async () => {
    if (!req.stat) {
      return
    }
    // let filePath = req.filePath
    // express middleware
    // let filePath = path.resolve(path.join(ROOT_DIR, req.url))
    // req.filePath = filePath
    /* if (filePath.indexOf(ROOT_DIR) !== 0) {
      res.send(400, 'Invalid path')
      return
    } */
    // let stat = await fs.promise.stat(filePath)
    // let stat = req.stat
    // if (stat.isDirectory()) {
    if (req.stat.isDirectory()) {
      // let files = await fs.promise.readdir(filePath)
      let files = await fs.promise.readdir(req.filePath)
      // res.setHeader('Content-Length', JSON.stringify(files.length)) - expensive operation
      res.body = JSON.stringify(files)
      /* THIS LINE WAS CAUSING ERROR:

      5 Sep 17:29:00 - [nodemon] v1.4.1
5 Sep 17:29:00 - [nodemon] to restart at any time, enter `rs`
5 Sep 17:29:00 - [nodemon] watching: *.*
5 Sep 17:29:00 - [nodemon] starting `babel-node --stage 1 --optional strict -- client.js`
Connecting ... Client dir: /var/folders/v5/5mbtgbl569xcddprmz8qq2j9cmpjg9/T/nodejs-dropbox-demo-client
Connected to server
stream.js:74
      throw er; // Unhandled stream error in pipe.
      ^

Error: Parse Error
    at Error (native)
    at Socket.socketOnData (_http_client.js:305:20)
    at emitOne (events.js:77:13)
    at Socket.emit (events.js:169:7)
    at readableAddChunk (_stream_readable.js:146:16)
    at Socket.Readable.push (_stream_readable.js:110:10)
    at TCP.onread (net.js:523:20)
5 Sep 17:29:01 - [nodemon] app crashed - waiting for file changes before starting...

*/
      // res.setHeader('Content-Length', res.body.length)
      res.setHeader('Content-Type', 'application/json')
      return
    }

    res.setHeader('Content-Length', req.stat.size)
    let contentType = mime.contentType(path.extname(req.filePath))
    res.setHeader('Content-Type', contentType)
  }(), next)
}
