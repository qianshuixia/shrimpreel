// scripts/doctor.mjs 的类型声明，供 tests/unit/config-health.test.ts 引用
import type { ConfigIssue } from '../src/server/config-health'

export type WranglerConfig = Record<string, any>

export function readWranglerConfig(file: string): WranglerConfig
export function configBindings(config: WranglerConfig): string[]
export function parsePendingMigrations(output: string): string[] | null
export function parseSecretNames(output: string): string[] | null
export type SiteTodo = { file: string; line: number; text: string }
export function findSiteTodos(root?: string): SiteTodo[]
export function runDoctor(
  config: WranglerConfig,
  options?: {
    secretNames?: string[] | null
    pendingMigrations?: string[] | null
    siteDomain?: string
    packageIds?: string[]
    planIds?: string[]
    styleProviders?: string[]
    siteTodos?: SiteTodo[]
  },
): ConfigIssue[]
