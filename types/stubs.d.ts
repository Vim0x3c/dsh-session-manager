/**
 * Dev-only ambient type stubs for the @deepseek-ai peer packages.
 *
 * These packages are not published to npm and are resolved at runtime from the
 * dsh application closure, so a clean install has no `node_modules/@deepseek-ai`
 * to typecheck against. These stubs give the plugin's own source a real surface
 * to compile against for `pnpm typecheck`; they mirror the small subset of the
 * dsh public API this plugin touches (client context, sessions, slots, locale,
 * invariants, snapshot store, and the API client). They are ambient declare
 * modules — never bundled or shipped — and are excluded from the publish files.
 *
 * Keep them in rough sync with packages/client/* in deepseek-harness. If a real
 * dsh workspace is mounted, drop this file and let tsc resolve the packages.
 */

declare module '@deepseek-ai/cordis' {
  export type Inject = string | string[] | { [key: string]: unknown } | undefined
  export interface Context {
    effect(fn: () => (() => void) | void | Promise<() => void>, name?: string): void
    on(event: string, handler: (...args: unknown[]) => void): () => void
    get<T>(name: string): T | undefined
    inject(keys: string[], setup: (ctx: this) => void): void
    provide(name: string, value: unknown): void
    plugin(fn: unknown): PromiseLike<{ dispose(): void }>
  }
}

declare module '@deepseek-ai/dsh-invariants' {
  import type { Context } from '@deepseek-ai/cordis'
  /** Install one package's checks into the registration's child context. */
  export interface InvariantInstaller {
    (ctx: Context, fail: (message: string) => never): void | Promise<void>
    readonly inject?: import('@deepseek-ai/cordis').Inject
  }
  export interface InvariantRegistry {
    register(packageName: string, installer: InvariantInstaller): () => void
  }
  declare module '@deepseek-ai/cordis' {
    interface Context { invariants: InvariantRegistry }
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  import type { Context } from '@deepseek-ai/cordis'
  export interface LocaleService {
    register(namespace: string, dict: Record<string, unknown>): void
    bind(namespace: string): (key: string) => string
  }
  declare module '@deepseek-ai/cordis' {
    interface Context { locale: LocaleService }
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context } from '@deepseek-ai/cordis'
  export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }
  export interface SnapshotStore<T> extends ObservableSnapshot<T> {
    update(mutator: (draft: T) => void): void
    set(next: T): void
  }
  export function createSnapshotStore<T>(init: T): SnapshotStore<T>
  export type SessionId = string
  export type ClientContext = Context
  export interface ISessions {
    open(id: SessionId): void
  }
  export interface SlotRegistry {
    inject(key: string, callback: () => unknown): () => void
    register(options: object, component: unknown): () => void
  }
  declare module '@deepseek-ai/cordis' {
    interface Context {
      sessions: ISessions
      slots: SlotRegistry
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
  export interface HooksSources {}
  export type SnapshotSelectorHook<T> = (selector: (snapshot: T) => unknown) => T
  export type PropsHooks<HS extends HooksSources> = {
    [N in keyof HS & string as `use${Capitalize<N>}`]:
    SnapshotSelectorHook<HS[N] extends { getSnapshot(): infer T } ? T : never>
  }
  /** Component-side view of an inject face: `hooks` becomes bound use<Name> hooks. */
  export type InjectFace<I extends object> =
    I extends { hooks: infer HS extends HooksSources } ? Omit<I, 'hooks'> & PropsHooks<HS> : I
  export type PropsRuntime<K extends string> = { close: () => void }
  export type PropsLocale<K extends string> = { t: (key: string) => string }
  export type StoreSpec<T, A> = { init: () => T; actions: A }
  export type StoreHandle<T, A> = { spec: StoreSpec<T, A>; create(): unknown }
  export type StoreInstance<T, A> = unknown
  export type ActionsDecl<T> = Record<string, (...params: unknown[]) => void>
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {}

declare module '@deepseek-ai/dsh-session-title/client' {}

declare module '@deepseek-ai/dsh-api-remotes/client' {
  export type SessionId = string
  export type HistoryEntry = {
    event: { type: string; time: number; data: Record<string, any> }
  }
  export interface RpcError { message: string }
  export interface RpcResponse<T> {
    result: { ok: true; value: T } | { ok: false; error: RpcError }
  }
  export interface SessionSummary {
    sessionId: SessionId
    updatedAt: number
    running: boolean
    blank: boolean
    parentSessionId?: SessionId
    origin?: 'subagent'
    cwd?: string
    agentPreset?: string
    projections?: { values: { title?: string | null } }
  }
  export interface ConnectionHandle {
    api: IApiClient
    isLoopback: boolean
    start(): { stop(): void }
  }
  export interface IApiClient {
    sessions: {
      list(req: { cursor?: string }): Promise<RpcResponse<{ items: SessionSummary[] }>>
      history(req: { sessionId: SessionId }): Promise<RpcResponse<{ events: HistoryEntry[] }>>
      delete(req: { sessionId: SessionId }): Promise<RpcResponse<{ deleted: true }>>
    }
    workspace: {
      list(req: Record<string, never>): Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export interface ButtonProps {
    variant?: string
    className?: string
    disabled?: boolean
    autoFocus?: boolean
    onClick?: () => void
    children?: unknown
  }
  export type Element = import('react').ReactNode
  export const Button: (props: ButtonProps) => Element
  export const Modal: (props: Record<string, unknown>) => Element
  export const IconListPenOutline16: (props: Record<string, unknown>) => Element
  export const IconTrashOutline16: (props: Record<string, unknown>) => Element
}
