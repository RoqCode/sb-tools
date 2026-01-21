#!/usr/bin/env node
import dotenv from 'dotenv'
import StoryblokClient from 'storyblok-js-client'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

dotenv.config()

type OutputMode = 'stdout' | 'txt'

type ParsedArgs = {
  help: boolean
  output?: string
  spaceId?: string
  list?: boolean
  delete?: boolean
  dryRun?: boolean
  inputFile?: string
  components?: string
}

const HELP_TEXT = `unused-components: Find unused Storyblok components in a space

Usage:
  unused-components --list [--space-id <id>] [--output <stdout|txt>] [--help]
  unused-components --delete --input-file <path> [--dry-run] [--space-id <id>]
  unused-components --delete --components <a,b,c> [--dry-run] [--space-id <id>]

Options:
  --space-id <id>      Override the space ID from .env
  --output <mode>      Output mode: stdout (default) or txt
  --list               List unused components (required unless --delete)
  --delete             Enable deletion mode (requires input list)
  --dry-run            Report what would happen without deleting
  --input-file <path>  Newline-separated component names to delete
  --components <list>  Comma-separated component names to delete
  --help, -h           Show this help message

Environment:
  STORYBLOK_OAUTH_TOKEN  Required. Storyblok OAuth token.
  STORYBLOK_SPACE_ID     Required unless --space-id is provided.
`

const log = (...args: unknown[]) => console.error(...args)

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    const anyError = error as Error & {
      response?: {
        status?: number
        statusText?: string
        data?: unknown
      }
    }

    if (anyError.response) {
      const { status, statusText, data } = anyError.response
      const statusLine = status ? `${status}${statusText ? ` ${statusText}` : ''}` : 'unknown status'
      const details = data ? safeStringify(data) : 'no response data'
      return `${error.message}\nStatus: ${statusLine}\nResponse: ${details}`
    }

    return error.message
  }

  if (typeof error === 'object' && error !== null) {
    return safeStringify(error)
  }

  return String(error)
}

type ComponentInfo = {
  id?: number
  name: string
}

type DeleteDecision = 'skip' | 'cancel' | 'force'

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

const createPrompt = () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  })

  const question = (text: string) =>
    new Promise<string>((resolve) => {
      rl.question(text, (answer) => resolve(answer))
    })

  return { question, close: () => rl.close() }
}

const promptDecision = async (
  prompt: string,
  allowed: Record<string, DeleteDecision>
): Promise<DeleteDecision> => {
  const { question, close } = createPrompt()
  try {
    while (true) {
      const answer = (await question(prompt)).trim().toLowerCase()
      if (allowed[answer]) {
        return allowed[answer]
      }
      log(`Please choose one of: ${Object.keys(allowed).join(', ')}`)
    }
  } finally {
    close()
  }
}

const requireInteractiveOrExit = (message: string) => {
  if (isInteractive()) {
    return
  }
  log(message)
  log('No TTY detected. Please review the input list and run again in an interactive shell.')
  process.exit(1)
}

const printHelp = () => {
  process.stdout.write(HELP_TEXT)
}

const parseArgs = (argv: string[]): ParsedArgs => {
  const parsed: ParsedArgs = { help: false }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      parsed.help = true
      continue
    }

    if (arg === '--list') {
      parsed.list = true
      continue
    }

    if (arg === '--output') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('Missing value for --output')
      }
      parsed.output = value
      i += 1
      continue
    }

    if (arg.startsWith('--output=')) {
      parsed.output = arg.split('=')[1]
      continue
    }

    if (arg === '--delete') {
      parsed.delete = true
      continue
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true
      continue
    }

    if (arg === '--input-file') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('Missing value for --input-file')
      }
      parsed.inputFile = value
      i += 1
      continue
    }

    if (arg.startsWith('--input-file=')) {
      parsed.inputFile = arg.split('=')[1]
      continue
    }

    if (arg === '--components') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('Missing value for --components')
      }
      parsed.components = value
      i += 1
      continue
    }

    if (arg.startsWith('--components=')) {
      parsed.components = arg.split('=')[1]
      continue
    }

    if (arg === '--space-id') {
      const value = argv[i + 1]
      if (!value) {
        throw new Error('Missing value for --space-id')
      }
      parsed.spaceId = value
      i += 1
      continue
    }

    if (arg.startsWith('--space-id=')) {
      parsed.spaceId = arg.split('=')[1]
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    throw new Error(`Unexpected argument: ${arg}`)
  }

  return parsed
}

const validateOutputMode = (mode?: string): OutputMode => {
  if (!mode || mode === 'stdout') {
    return 'stdout'
  }

  if (mode === 'txt') {
    return 'txt'
  }

  throw new Error(`Invalid output mode: ${mode}`)
}

const getRequiredEnv = (key: string): string | undefined => {
  const value = process.env[key]
  return value ? value.trim() : undefined
}

const normalizeNames = (names: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name) {
      continue
    }
    if (!seen.has(name)) {
      seen.add(name)
      result.push(name)
    }
  }
  return result
}

const parseComponentsList = (value: string): string[] =>
  normalizeNames(value.split(','))

const readInputFile = async (filePath: string): Promise<string[]> => {
  const content = await fs.readFile(filePath, 'utf8')
  return normalizeNames(content.split(/\r?\n/))
}

const isComponentUsed = async (
  storyblok: StoryblokClient,
  spaceId: string,
  componentName: string
): Promise<boolean> => {
  const response = await storyblok.get(`spaces/${spaceId}/stories/`, {
    contain_component: componentName,
    per_page: 1
  })
  return response?.data?.stories?.length > 0
}

const deleteComponent = async (
  storyblok: StoryblokClient,
  spaceId: string,
  componentId: number
) => {
  const client = storyblok as unknown as {
    delete?: (path: string) => Promise<unknown>
    del?: (path: string) => Promise<unknown>
    request?: (path: string, config?: { method: string }) => Promise<unknown>
  }

  const requestPath = `spaces/${spaceId}/components/${componentId}`

  if (typeof client.delete === 'function') {
    await client.delete(requestPath)
    return
  }

  if (typeof client.del === 'function') {
    await client.del(requestPath)
    return
  }

  if (typeof client.request === 'function') {
    await client.request(requestPath, { method: 'DELETE' })
    return
  }

  throw new Error('Storyblok client does not support delete requests.')
}

const fetchComponents = async (
  storyblok: StoryblokClient,
  spaceId: string
): Promise<ComponentInfo[]> => {
  const perPage = 100
  let page = 1
  const components: ComponentInfo[] = []
  const seen = new Set<string>()

  while (true) {
    log(`Loading components (page ${page})`)
    const response = await storyblok.get(`spaces/${spaceId}/components/`, {
      per_page: perPage,
      page
    })

    const pageComponents = response?.data?.components ?? []
    const headers = (response as unknown as { headers?: unknown }).headers
    const recordHeaders =
      typeof headers === 'object' && headers !== null
        ? (headers as Record<string, unknown>)
        : undefined
    const headerGetter =
      headers && typeof (headers as { get?: unknown }).get === 'function'
        ? ((headers as { get: (key: string) => string | null }).get)
        : undefined
    const totalRaw =
      recordHeaders?.total ??
      recordHeaders?.['x-total'] ??
      headerGetter?.('total') ??
      response?.data?.total ??
      (response as { total?: unknown })?.total
    const total = typeof totalRaw === 'string' ? Number(totalRaw) : totalRaw

    let newCount = 0
    for (const component of pageComponents) {
      const key = String((component as { id?: number }).id ?? component.name)
      if (!seen.has(key)) {
        seen.add(key)
        components.push(component)
        newCount += 1
      }
    }

    if (typeof total === 'number' && Number.isFinite(total)) {
      if (components.length >= total) {
        break
      }
    } else if (pageComponents.length < perPage) {
      break
    } else if (newCount === 0) {
      log('No new components returned; stopping pagination to avoid a loop.')
      break
    }

    page += 1
  }

  return components
}

const main = async () => {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(message)
    log('Run with --help for usage.')
    process.exit(1)
  }

  if (parsed.help) {
    printHelp()
    return
  }

  if (parsed.list && parsed.delete) {
    log('Choose either --list or --delete, not both.')
    log(HELP_TEXT)
    process.exit(1)
  }

  if (!parsed.list && !parsed.delete) {
    log('Missing mode flag. Provide either --list or --delete.')
    log(HELP_TEXT)
    process.exit(1)
  }

  const outputMode = validateOutputMode(parsed.output)

  if (parsed.dryRun && !parsed.delete) {
    log('The --dry-run flag is only valid with --delete.')
    process.exit(1)
  }

  const inputFlags = Number(Boolean(parsed.inputFile)) + Number(Boolean(parsed.components))
  if (parsed.delete && inputFlags !== 1) {
    log('Deletion requires exactly one input source: --input-file or --components.')
    process.exit(1)
  }
  if (!parsed.delete && inputFlags > 0) {
    log('The --input-file and --components flags are only valid with --delete.')
    process.exit(1)
  }

  const token = getRequiredEnv('STORYBLOK_OAUTH_TOKEN')
  const spaceId = parsed.spaceId ?? getRequiredEnv('STORYBLOK_SPACE_ID')

  if (!token) {
    log('Missing Storyblok OAuth token. Set STORYBLOK_OAUTH_TOKEN in your .env file.')
    process.exit(1)
  }

  if (!spaceId) {
    log('Missing Storyblok space ID. Set STORYBLOK_SPACE_ID in your .env file or pass --space-id.')
    process.exit(1)
  }

  const storyblok = new StoryblokClient({ oauthToken: token })

  log('Loading list of components')
  const components = await fetchComponents(storyblok, spaceId)

  const componentByName = new Map<string, ComponentInfo>()
  for (const component of components) {
    if (componentByName.has(component.name)) {
      log(`Duplicate component name detected: ${component.name}`)
      process.exit(1)
    }
    componentByName.set(component.name, component)
  }

  if (parsed.delete) {
    const inputNames = parsed.inputFile
      ? await readInputFile(parsed.inputFile)
      : parseComponentsList(parsed.components ?? '')

    if (inputNames.length === 0) {
      log('No component names provided for deletion.')
      process.exit(1)
    }

    const missingEntries: { name: string; reason: string }[] = []
    const candidates: { name: string; id: number }[] = []

    for (const name of inputNames) {
      const component = componentByName.get(name)
      if (!component) {
        missingEntries.push({ name, reason: 'not found in space' })
        continue
      }
      if (typeof component.id !== 'number') {
        missingEntries.push({ name, reason: 'missing component id' })
        continue
      }
      candidates.push({ name, id: component.id })
    }

    if (missingEntries.length > 0) {
      const details = missingEntries
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join(os.EOL)
      log('Some components could not be resolved:')
      log(details)

      if (parsed.dryRun) {
        log('Dry run: skipping unresolved components.')
      } else {
        requireInteractiveOrExit('Unresolved component names detected in the input list.')
        for (const entry of missingEntries) {
          const decision = await promptDecision(
            `Component \"${entry.name}\" is ${entry.reason}. Skip or cancel? [s/c]: `,
            { s: 'skip', skip: 'skip', c: 'cancel', cancel: 'cancel' }
          )
          if (decision === 'cancel') {
            log('Deletion cancelled.')
            process.exit(1)
          }
        }
      }
    }

    log(`Rechecking usage for ${candidates.length} components`)
    const usedCandidates: { name: string; id: number }[] = []
    const unusedCandidates: { name: string; id: number }[] = []

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const inUse = await isComponentUsed(storyblok, spaceId, candidate.name)
      if (inUse) {
        usedCandidates.push(candidate)
      } else {
        unusedCandidates.push(candidate)
      }
      log(`Checking component usage (${index + 1}/${candidates.length})`)
    }

    if (parsed.dryRun) {
      log('Dry run summary:')
      log(`Unused components: ${unusedCandidates.length}`)
      log(`Used components: ${usedCandidates.length}`)
      if (missingEntries.length > 0) {
        log(`Unresolved components: ${missingEntries.length}`)
      }
      return
    }

    const toDelete: { name: string; id: number }[] = [...unusedCandidates]

    if (usedCandidates.length > 0) {
      requireInteractiveOrExit('Some components are still in use.')
      for (const candidate of usedCandidates) {
        const decision = await promptDecision(
          `Component \"${candidate.name}\" is in use. Skip, cancel, or force delete? [s/c/f]: `,
          {
            s: 'skip',
            skip: 'skip',
            c: 'cancel',
            cancel: 'cancel',
            f: 'force',
            force: 'force'
          }
        )

        if (decision === 'cancel') {
          log('Deletion cancelled.')
          process.exit(1)
        }

        if (decision === 'force') {
          toDelete.push(candidate)
        }
      }
    }

    if (toDelete.length === 0) {
      log('No components selected for deletion.')
      return
    }

    for (const candidate of toDelete) {
      log(`Deleting component ${candidate.name} (${candidate.id})`)
      await deleteComponent(storyblok, spaceId, candidate.id)
    }

    log(`Deleted components: ${toDelete.length}`)
    return
  }

  if (!parsed.list) {
    log('Listing unused components requires --list.')
    process.exit(1)
  }

  log(`Checking ${components.length} components for usage`)

  const unusedComponents: string[] = []
  const usedComponents: string[] = []

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]
    const componentName = component.name

    const inUse = await isComponentUsed(storyblok, spaceId, componentName)

    if (inUse) {
      usedComponents.push(componentName)
    } else {
      unusedComponents.push(componentName)
    }

    log(`Looking for unused components (${index + 1}/${components.length})`)
  }

  const outputText = unusedComponents.length
    ? `${unusedComponents.join(os.EOL)}${os.EOL}`
    : ''

  if (outputMode === 'stdout') {
    process.stdout.write(outputText)
  } else {
    const fileName = `unused-components-${spaceId}.txt`
    const filePath = path.resolve(process.cwd(), fileName)
    await fs.writeFile(filePath, outputText, 'utf8')
    log(`Wrote ${unusedComponents.length} unused components to ${fileName}`)
  }

  log(`Used components: ${usedComponents.length}`)
  log(`Unused components: ${unusedComponents.length}`)
}

main().catch((error) => {
  log('Error encountered while running unused-components.')
  log(formatError(error))
  process.exit(1)
})
