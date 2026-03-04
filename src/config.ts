import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export const ENDPOINT_TYPES = [
	'HMS-4X',
	'HRM-4X',
	'HKB-2X',
	'HBP-2X',
	'FSII-BP',
	'E-BP',
	'NEP',
	'V-Series-12',
	'V-Series-24',
	'V-Series-32',
] as const

export type ModuleConfig = {
	host: string
	password: string
	endpointTypes: string[]
	logLevel?: 'debug' | 'info' | 'none'
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Arcadia IP',
			width: 4,
			regex: Regex.IP,
		},
		{
			type: 'textinput',
			id: 'password',
			label: 'Admin Password',
			width: 8,
		},
		{
			type: 'multidropdown',
			id: 'endpointTypes',
			label: 'Endpoint Types',
			width: 12,
			default: [],
			choices: ENDPOINT_TYPES.map((t) => ({ id: t, label: t })),
		},
		{
			type: 'dropdown',
			id: 'logLevel',
			label: 'Log Level',
			width: 12,
			default: 'info',
			choices: [
				{ id: 'debug', label: 'Debug' },
				{ id: 'info', label: 'Info' },
				{ id: 'none', label: 'None' },
			],
		},
	]
}
