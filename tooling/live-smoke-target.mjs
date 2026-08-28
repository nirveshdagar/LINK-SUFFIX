import http from 'node:http'

const port = Number(process.env.SMOKE_TARGET_PORT ?? 3200)
const delay = Number(process.env.SMOKE_TARGET_DELAY_MS ?? 500)
http.createServer((_request, response) => {
  setTimeout(() => {
    response.writeHead(200, { 'content-type': 'text/html', 'x-smoke-target': 'traffic-armour' })
    response.end('<!doctype html><title>Traffic Armour Smoke Target</title><main>authorized local smoke target</main>')
  }, delay)
}).listen(port, '127.0.0.1', () => console.log(`smoke target listening on http://127.0.0.1:${port}`))
