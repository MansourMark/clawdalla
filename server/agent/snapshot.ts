// File checkpoints for undo. Uses a private git store outside the project, so the
// project's own git history is never touched.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function git(cwd: string, args: string[], env: Record<string, string> = {}, timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'safe.directory=*', ...args], { cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().slice(0, 500)))
      else resolve(stdout)
    })
  })
}

let gitOk: boolean | undefined
export async function hasGit() {
  if (gitOk === undefined) gitOk = await git(process.cwd(), ['--version']).then(() => true, () => false)
  return gitOk
}

export class Snapshots {
  constructor(private root: string) {}
  private env(dir: string) {
    const store = join(this.root, createHash('sha1').update(dir).digest('hex').slice(0, 16))
    return { store, env: { GIT_DIR: store, GIT_WORK_TREE: dir } }
  }
  private async ensure(dir: string) {
    const { store, env } = this.env(dir)
    if (!existsSync(join(store, 'HEAD'))) {
      mkdirSync(store, { recursive: true })
      await git(dir, ['init', '-q'], env)
      mkdirSync(join(store, 'info'), { recursive: true })
      writeFileSync(join(store, 'info', 'exclude'), 'node_modules/\n.venv/\nvenv/\ntarget/\ndist/\nbuild/\n.next/\n__pycache__/\n*.log\n')
    }
    return env
  }
  /** Record the current files; returns an id, or undefined when git is not installed. */
  async take(dir: string): Promise<string | undefined> {
    if (!(await hasGit())) return undefined
    try {
      const env = await this.ensure(dir)
      await git(dir, ['add', '-A', '.'], env, 120000)
      return (await git(dir, ['write-tree'], env)).trim()
    } catch { return undefined }
  }
  /** Put files back to a snapshot. Returns a snapshot of the state just before, for redo. */
  async restore(dir: string, tree: string): Promise<string | undefined> {
    const before = await this.take(dir)
    const env = await this.ensure(dir)
    await git(dir, ['read-tree', '-u', '--reset', tree], env, 120000)
    return before
  }
}
