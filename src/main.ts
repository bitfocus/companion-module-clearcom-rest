import { InstanceTypes, InstanceBase, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { getRequest, postRequest, connectArcadiaSocket, disconnectArcadiaSocket } from './rest.js'
import { BeltpackLiveStatus, Roleset, Keyset } from './types.js'

export type { BeltpackLiveStatus }

export interface ModuleTypes extends InstanceTypes {
	config: ModuleConfig
}

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	config!: ModuleConfig
	bearerToken: string = ''
	beltpackStatus: Map<number, BeltpackLiveStatus> = new Map()
	rolesets: Map<number, Roleset> = new Map()
	keysets: Map<number, Keyset> = new Map()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		console.log('Inside init.')
		this.config = config
		this.updateStatus(InstanceStatus.Connecting)
		void this.getAPI()
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
	}

	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
		disconnectArcadiaSocket(this)
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	async getAPI(): Promise<void> {
		const apiBaseUrl = `http://${this.config.host}`
		try {
			const postData = {
				logemail: 'admin',
				logpassword: this.config.password,
			}
			console.log('posting: ', apiBaseUrl + '/auth/local/login')
			const postResponse = await postRequest<{ jwt: string }>(apiBaseUrl + '/auth/local/login', this, postData) // bearerToken is '' at login
			console.log('POST Response:', postResponse)

			if (postResponse) {
				this.bearerToken = postResponse.jwt
				console.log('\nBEARER TOKEN:\n', this.bearerToken, '\n\n')
				console.log(await getRequest('http://' + this.config.host + '/api/1/devices', this))

				connectArcadiaSocket(this)
			}
		} catch (err) {
			console.error(err as Error)
		}
	}
}

export { UpgradeScripts }
