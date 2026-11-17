// Runs the Clawdalla host without the desktop window (useful on a headless main computer and for development).
import { join } from 'node:path'
import { startServer } from './index'

const dataDir = process.env.CLAWDALLA_DATA || join(process.cwd(), '.data')
const root = join(__dirname, '..')
startServer({
  dataDir,
  webDir: join(__dirname, 'web'),
  port: process.env.CLAWDALLA_PORT ? Number(process.env.CLAWDALLA_PORT) : undefined,
  browserCli: join(root, 'node_modules', '@playwright', 'mcp', 'cli.js'),
}).then((s) => {
  console.log(`Clawdalla is running. Open ${s.localUrl}`)
  console.log(`Data folder: ${dataDir}`)
})
