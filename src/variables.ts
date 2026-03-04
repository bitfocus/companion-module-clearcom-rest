import ModuleInstance from './main.js'

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	const s = Math.floor(seconds % 60)
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function UpdateVariableDefinitions(instance: ModuleInstance): void {
	const fans = instance.deviceInfo?.device_liveStatus?.fanStatus ?? []
	const temps = instance.deviceInfo?.device_liveStatus?.temperatureSensors ?? []

	instance.setVariableDefinitions([
		{ variableId: 'device_label', name: 'Device Label' },
		{ variableId: 'device_type', name: 'Device Type' },
		{ variableId: 'firmware_version', name: 'Firmware Version' },
		{ variableId: 'uptime', name: 'Uptime (hh:mm:ss)' },
		...fans.map((f) => ({ variableId: `fan_speed_${f.Name}`, name: `Fan ${f.Name} Speed (%)` })),
		...temps.map((t) => ({
			variableId: `temp_${t.sensorName.replace(/\s+/g, '_')}`,
			name: `Temp ${t.sensorName} (°C)`,
		})),
	])
}

export function UpdateVariableValues(instance: ModuleInstance): void {
	const info = instance.deviceInfo
	if (!info) return
	const fans = info.device_liveStatus?.fanStatus ?? []
	const temps = info.device_liveStatus?.temperatureSensors ?? []

	const values: Record<string, string | number> = {
		device_label: info.device_label ?? '',
		device_type: info.deviceType_name ?? '',
		firmware_version: info.versionSW ?? '',
		uptime: formatUptime(info.uptime ?? 0),
	}

	for (const f of fans) {
		values[`fan_speed_${f.Name}`] = f.SpeedPercentageOfMax
	}
	for (const t of temps) {
		values[`temp_${t.sensorName.replace(/\s+/g, '_')}`] = t.temperatureCentigrade
	}

	instance.setVariableValues(values)
}
