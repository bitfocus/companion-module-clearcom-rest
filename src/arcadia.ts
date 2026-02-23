import ModuleInstance from './main.js'
import { postRequest, getRequest } from './rest.js'

export async function remoteMicKill(instance: ModuleInstance, deviceId: number): Promise<void> {
	const apiBaseUrl = `http://${instance.config.host}`
	const endpoint = `${apiBaseUrl}/api/1/devices/${deviceId}/endpoints/rmk`

	try {
		const response = await postRequest(endpoint, instance.bearerToken, {})
		instance.log('info', `RMK sent to device ${deviceId}: ${JSON.stringify(response)}`)

		// Get live status after RMK
		await getLiveStatus(instance)
	} catch (error) {
		instance.log('error', `Failed to send RMK to device ${deviceId}: ${error}`)
	}
}

export async function getLiveStatus(instance: ModuleInstance): Promise<unknown> {
	const apiBaseUrl = `http://${instance.config.host}`
	const endpoint = `${apiBaseUrl}/api/1/connections/liveStatus`

	try {
		const response = await getRequest(endpoint, instance.bearerToken)
		console.log('Live status retrieved:', response)
		return response
	} catch (error) {
		instance.log('error', `Failed to get live status: ${error}`)
		return null
	}
}
