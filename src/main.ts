import {
	InstanceTypes,
	InstanceBase,
	InstanceStatus,
	SomeCompanionConfigField,
	CompanionFeedbackSchema,
	CompanionOptionValues,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { postRequest, fetchDevice } from './network.js'
import { makeLogger } from './logger.js'
import { connect, disconnect, filterControlDefs } from './commands.js'
import { loadSchemasAndRefs, clearSchemaCache } from './loadSchemas.js'
import { buildControlDefs, parseKeyAssignCapabilities } from './parseSchemas.js'
import { DeviceRecord, DeviceInfo, ControlDef, KeyAssignCapabilities, FeedbackStore } from './types.js'

export interface ModuleTypes extends InstanceTypes {
	config: ModuleConfig
	secrets: ModuleSecrets
	feedbacks: Record<string, CompanionFeedbackSchema<CompanionOptionValues>>
}

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	config!: ModuleConfig
	secrets!: ModuleSecrets
	bearerToken: string = ''

	// ─── Device data stores ────────────────────────────────────────────────────
	ports: Map<number, DeviceRecord> = new Map()
	endpoints: Map<number, DeviceRecord> = new Map()
	gateways: Map<number, DeviceRecord> = new Map()
	endpointStatus: Map<number, DeviceRecord> = new Map()
	rolesets: Map<number, DeviceRecord> = new Map()
	keysets: Map<number, DeviceRecord> = new Map()
	connections: Map<number, DeviceRecord> = new Map()
	deviceInfo: DeviceInfo | null = null

	// ─── Schema-derived control definitions ───────────────────────────────────
	controlDefs: ControlDef[] = []
	keyAssignCapabilities: Record<string, KeyAssignCapabilities> = {}

	// ─── Feedback trigger registry ────────────────────────────────────────────
	feedbackTriggers: Map<string, FeedbackStore> = new Map()

	// ─── Nulling state ────────────────────────────────────────────────────────
	nullingStatus: Map<number, string> = new Map()

	private readonly _log = makeLogger('main', () => this.config)

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		void isFirstInit
		this.secrets = secrets
		await this.configUpdated(config, secrets)
	}

	async destroy(): Promise<void> {
		this._log.debug('destroy')
		disconnect()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		const hostChanged = config.host !== this.config?.host

		// If the refresh flag is set, clear the cache and reset the flag in one
		// atomic saveConfig call — before the restart that saveConfig triggers.
		if (config.refreshSchema) {
			config = clearSchemaCache(config)
			this.config = config
			this.secrets = secrets
			this.saveConfig(config, undefined)
			// saveConfig will trigger a restart; nothing further needed here
			return
		}

		this.config = config
		this.secrets = secrets
		if (hostChanged || !this.bearerToken) {
			disconnect()
			this.updateStatus(InstanceStatus.Connecting)
			await this.connect()
		}
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	private _choicesFingerprint = ''

	choicesFingerprint(): string {
		const endpoints = [...this.endpoints.values()]
			.map((e) => {
				const dpId = (
					this.endpointStatus.get(e['id'] as number)?.['association'] as Record<string, unknown> | undefined
				)?.['dpId'] as number | undefined
				return `${e['id'] as number}:${e['label'] as string}:${dpId ?? 0}`
			})
			.join(',')
		const rolesets = [...this.rolesets.values()].map((r) => `${r['id']}:${r['label'] ?? r['name']}`).join(',')
		const ports = [...this.ports.values()].map((p) => `${p['port_id']}:${p['port_label']}`).join(',')
		const connections = [...this.connections.values()].map((c) => `${c['id']}:${c['label']}`).join(',')
		const keysets = [...this.keysets.keys()].join(',')
		return `${endpoints}|${rolesets}|${ports}|${connections}|${keysets}`
	}

	rebuildIfChanged(): void {
		const fp = this.choicesFingerprint()
		if (fp === this._choicesFingerprint) return
		this._choicesFingerprint = fp
		UpdateActions(this)
		UpdateFeedbacks(this)
	}

	forceRebuild(): void {
		this._choicesFingerprint = ''
		this.rebuildIfChanged()
	}

	updateVariables(): void {
		if (!this.deviceInfo) return
		console.log('\nCalling updateVariableDefinitions\n')
		UpdateVariableDefinitions(this)
		console.log('\nCalling updateVariableValues\n')
		UpdateVariableValues(this)
	}

	triggerFeedbacksForStore(store: string): void {
		const ids = [...this.feedbackTriggers.entries()].filter(([_, s]) => s === store).map(([id]) => id)
		if (ids.length > 0) this.checkFeedbacks(ids[0], ...ids.slice(1))
	}

	async connect(): Promise<void> {
		const apiBaseUrl = `http://${this.config.host}`
		try {
			const loginResponse = await postRequest<{ jwt: string }>(`${apiBaseUrl}/auth/local/login`, this, {
				logemail: 'admin',
				logpassword: this.secrets.password,
			})
			if (!loginResponse) {
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Login failed')
				await this._loadSchemasOffline(apiBaseUrl)
				return
			}
			this.bearerToken = loginResponse.jwt

			await fetchDevice(this)

			const loaded = await loadSchemasAndRefs(this, apiBaseUrl)
			this.controlDefs = filterControlDefs(buildControlDefs(loaded))
			this.keyAssignCapabilities = parseKeyAssignCapabilities(loaded)
			this._log.info(
				`Schema version: ${loaded.mainSchema.info.version} — ${this.controlDefs.length} control defs loaded`,
			)

			connect(this)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			this._log.warn(`Connection failed: ${msg}`)
			this.updateStatus(InstanceStatus.Disconnected, msg)
			await this._loadSchemasOffline(apiBaseUrl)
		}
	}

	private async _loadSchemasOffline(apiBaseUrl: string): Promise<void> {
		if (!this.config.schemaCache || Object.keys(this.config.schemaCache).length === 0) return
		try {
			const loaded = await loadSchemasAndRefs(this, apiBaseUrl)
			this.controlDefs = filterControlDefs(buildControlDefs(loaded))
			this.keyAssignCapabilities = parseKeyAssignCapabilities(loaded)
			this._log.info(`Offline: loaded ${this.controlDefs.length} control defs from cache`)
			this.forceRebuild()
		} catch (err) {
			this._log.warn(`Could not load offline schemas: ${err}`)
		}
	}
}

export { UpgradeScripts }
