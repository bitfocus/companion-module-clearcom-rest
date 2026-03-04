import {
	InstanceTypes,
	InstanceBase,
	InstanceStatus,
	SomeCompanionConfigField,
	CompanionFeedbackSchema,
	CompanionOptionValues,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { postRequest } from './network.js'
import { connect, disconnect, filterControlDefs } from './commands.js'
import { loadSchemasAndRefs } from './loadSchemas.js'
import { buildControlDefs, parseKeyAssignCapabilities } from './parseSchemas.js'
import { DeviceRecord, DeviceInfo, ControlDef, KeyAssignCapabilities, FeedbackStore } from './types.js'

export interface ModuleTypes extends InstanceTypes {
	config: ModuleConfig
	feedbacks: Record<string, CompanionFeedbackSchema<CompanionOptionValues>>
}

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	config!: ModuleConfig
	bearerToken: string = ''

	// ─── Device data stores (all generic — schema is source of truth) ─────────
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
	// Maps feedbackId → which store it reads from.
	// Used by triggerFeedbacksForStore() to re-check only relevant feedbacks.
	feedbackTriggers: Map<string, FeedbackStore> = new Map()

	// ─── Nulling state ────────────────────────────────────────────────────────
	nullingStatus: Map<number, string> = new Map()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.updateVariableDefinitions()
		await this.configUpdated(config)
	}

	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		disconnect(this)
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		disconnect(this)
		this.updateStatus(InstanceStatus.Connecting)
		await this.connect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	// Fingerprint of current dropdown choices — used to avoid unnecessary rebuilds.
	// Only the things that appear in action/feedback dropdowns are included.
	private _choicesFingerprint = ''

	choicesFingerprint(): string {
		const endpoints = [...this.endpoints.values()].map((e) => `${e['id']}:${e['label']}`).join(',')
		const rolesets = [...this.rolesets.values()].map((r) => `${r['id']}:${r['label'] ?? r['name']}`).join(',')
		const ports = [...this.ports.values()].map((p) => `${p['port_id']}:${p['port_label']}`).join(',')
		return `${endpoints}|${rolesets}|${ports}`
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	rebuildIfChanged(): void {
		const fp = this.choicesFingerprint()
		if (fp === this._choicesFingerprint) return
		this._choicesFingerprint = fp
		this.updateActions()
		this.updateFeedbacks()
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	updateVariables(): void {
		if (!this.deviceInfo) return
		UpdateVariableDefinitions(this)
		UpdateVariableValues(this)
	}

	// Re-check all feedbacks that read from the given store
	triggerFeedbacksForStore(store: string): void {
		const ids = [...this.feedbackTriggers.entries()].filter(([_, s]) => s === store).map(([id]) => id)
		if (ids.length > 0) {
			this.checkFeedbacks(ids[0], ...ids.slice(1))
		}
	}

	async connect(): Promise<void> {
		const apiBaseUrl = `http://${this.config.host}`
		try {
			const loginResponse = await postRequest<{ jwt: string }>(`${apiBaseUrl}/auth/local/login`, this, {
				logemail: 'admin',
				logpassword: this.config.password,
			})
			if (!loginResponse) {
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Login failed')
				return
			}
			this.bearerToken = loginResponse.jwt

			const loaded = await loadSchemasAndRefs(this, apiBaseUrl)
			this.controlDefs = filterControlDefs(buildControlDefs(loaded))
			this.keyAssignCapabilities = parseKeyAssignCapabilities(loaded)
			this.log(
				'info',
				`Schema version: ${loaded.mainSchema.info.version} — ${this.controlDefs.length} control defs loaded`,
			)

			connect(this)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			this.log('error', msg)
			this.updateStatus(InstanceStatus.UnknownError, msg)
		}
	}
}

export { UpgradeScripts }
