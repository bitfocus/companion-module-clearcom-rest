import { InstanceTypes, InstanceBase, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { OpenAPIV3 } from 'openapi-types'
import { loadSchemasAndRefs } from './createcmds.js'
import { getRequest, postRequest } from './rest.js'

export interface ModuleTypes extends InstanceTypes {
	config: ModuleConfig
}

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	config!: ModuleConfig // Setup in init()
	bearerToken: string = ''
	apiSchema: OpenAPIV3.Document | null = null

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		console.log('Inside init.')
		this.config = config
		this.updateStatus(InstanceStatus.Ok)
		void this.getAPI()
		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.log('debug', 'destroy')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
	}

	// Return config fields for web config
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
		const bearerToken = ''
		try {
			// POST request
			const postData = {
				logemail: 'admin',
				logpassword: this.config.password,
			}

			const postResponse = await postRequest(apiBaseUrl + '/auth/local/login', bearerToken, postData)
			console.log('POST Response:', postResponse)

			if (postResponse) {
				this.bearerToken = postResponse.jwt
				console.log('\nBEARER TOKEN:\n', this.bearerToken, '\n\n')

				console.log(await getRequest(`http://${this.config.host}/api/1/devices`, this.bearerToken))

				// Load OpenAPI schema
				const loadedSchemas = await loadSchemasAndRefs(this, apiBaseUrl)
				this.apiSchema = loadedSchemas.mainSchema
			}
		} catch (err) {
			console.error(err as Error)
		}
	}
}

export { UpgradeScripts }
