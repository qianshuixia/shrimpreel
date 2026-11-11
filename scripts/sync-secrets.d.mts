// scripts/sync-secrets.mjs 的类型声明，供 tests/unit/sync-secrets.test.ts 引用
import type { WranglerConfig } from './doctor.mjs'

export type WranglerResult = { ok: boolean; output: string }
export type SecretPlan = {
  errors: string[]
  add: string[]
  update: string[]
  kept: string[]
  remoteOnly: string[]
  missing: string[]
  payload: Record<string, string>
}

export function parseDotenv(text: string): { entries: [string, string][]; errors: string[] }
export function exampleSecrets(text: string): Map<string, string>
export function planSecrets(input: {
  entries: [string, string][]
  example: string
  remoteNames: string[] | null
  config: WranglerConfig
  overwrite?: boolean
  siteDomain?: string
  packageIds?: string[]
  planIds?: string[]
  styleProviders?: string[]
}): SecretPlan
export function redact(output: string, values: string[]): string
export function main(
  args: string[],
  deps?: {
    wrangler?: (args: string[], input?: string) => WranglerResult
    gitIgnored?: (file: string) => boolean
    log?: (line: string) => void
  },
): number
