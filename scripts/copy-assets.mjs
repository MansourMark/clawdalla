import { copyFileSync, mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
copyFileSync('build/tray.png', 'dist/tray.png')
copyFileSync('build/icon.png', 'dist/icon.png')
