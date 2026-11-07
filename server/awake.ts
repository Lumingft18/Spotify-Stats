// Keep the Mac awake while enrichment is running: `caffeinate -is` when on AC power.
// Idle/system sleep would freeze the browser jobs; on battery we leave sleep alone.
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { platform } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let wanted = false
let proc: ChildProcess | null = null
let timer: ReturnType<typeof setInterval> | null = null
let lastOnAC = false

export interface AwakeStatus {
  wanted: boolean
  holding: boolean
  onAC: boolean
  supported: boolean
}

async function onAC(): Promise<boolean> {
  if (platform() !== 'darwin') return false
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'ps'], { timeout: 3000 })
    return /AC Power/i.test(stdout)
  } catch {
    return false
  }
}

function stopCaffeinate() {
  if (!proc) return
  try {
    proc.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  proc = null
}

function startCaffeinate() {
  if (proc || platform() !== 'darwin') return
  proc = spawn('caffeinate', ['-is'], { stdio: 'ignore' })
  proc.on('exit', () => {
    proc = null
  })
  proc.on('error', () => {
    proc = null
  })
}

async function tick(): Promise<AwakeStatus> {
  const supported = platform() === 'darwin'
  const ac = supported ? await onAC() : false
  lastOnAC = ac
  if (wanted && ac && supported) startCaffeinate()
  else stopCaffeinate()
  return { wanted, holding: !!proc, onAC: ac, supported }
}

/** Client asks to hold (jobs running) or release. Re-checks AC every 30s while held. */
export async function setAwakeWanted(on: boolean): Promise<AwakeStatus> {
  wanted = on
  if (on && !timer) timer = setInterval(() => void tick(), 30_000)
  if (!on && timer) {
    clearInterval(timer)
    timer = null
  }
  return tick()
}

export function getAwakeStatus(): AwakeStatus {
  return { wanted, holding: !!proc, onAC: lastOnAC, supported: platform() === 'darwin' }
}

export function shutdownAwake() {
  wanted = false
  if (timer) clearInterval(timer)
  timer = null
  stopCaffeinate()
}
