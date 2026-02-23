import { CompanionActionDefinitions, CompanionActionEvent } from '@companion-module/base'
import ModuleInstance from './main.js'
import * as arcadia from './arcadia.js'

export function UpdateActions(instance: ModuleInstance): void {
	const actions: CompanionActionDefinitions = {
		remote_mic_kill: {
			name: 'Remote Mic Kill (RMK)',
			options: [
				{
					type: 'number',
					label: 'Device ID',
					id: 'deviceId',
					default: 1,
					min: 1,
					max: 999,
					tooltip: 'The device ID to send RMK command to',
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const deviceId = action.options.deviceId as number
				await arcadia.remoteMicKill(instance, deviceId)
			},
		},
	}

	instance.setActionDefinitions(actions)
}
