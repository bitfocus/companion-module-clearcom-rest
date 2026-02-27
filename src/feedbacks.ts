import ModuleInstance from './main.js'
import {
	buildKeysetFeedbacks,
	buildLiveStatusFeedbacks,
	buildKeyStateFeedbacks,
	buildGatewayFeedbacks,
} from './createcmds.js'
import { drawMeter, MeterStyle } from './indicators.js'
import type { CompanionAdvancedFeedbackDefinition } from '@companion-module/base'

const STYLE_CHOICES: Array<{ id: MeterStyle; label: string }> = [
	{ id: 'bar-horizontal', label: 'Bar (horizontal)' },
	{ id: 'bar-vertical', label: 'Bar (vertical)' },
	{ id: 'circle', label: 'Circle' },
]

function buildMeterFeedbacks(): Record<string, CompanionAdvancedFeedbackDefinition> {
	return {
		meter: {
			type: 'advanced',
			name: '[Meter]',
			options: [
				{ type: 'dropdown', id: 'style', label: 'Style', default: 'bar-horizontal', choices: STYLE_CHOICES },
				{ type: 'number', id: 'thickness', label: 'Thickness', default: 8, min: 1, max: 72 },
				{ type: 'number', id: 'x', label: 'X Position', default: 0, min: -60, max: 60 },
				{ type: 'number', id: 'y', label: 'Y Position', default: 0, min: -60, max: 60 },
				{ type: 'number', id: 'scale', label: 'Scale', default: 1, min: 0.2, max: 1, step: 0.01, range: true },
				{ type: 'number', id: 'min', label: 'Min', default: 0, min: -999, max: 999 },
				{ type: 'number', id: 'max', label: 'Max', default: 100, min: -999, max: 999 },
				{
					type: 'number',
					id: 'yellowStart',
					label: 'Yellow From',
					default: 50,
					min: -999,
					max: 999,
					tooltip: 'Make Yellow > Red to reverse the colors',
				},
				{
					type: 'number',
					id: 'redStart',
					label: 'Red From',
					default: 75,
					min: -999,
					max: 999,
					tooltip: 'Make Yellow > Red to reverse the colors',
				},
				{ type: 'textinput', id: 'value', label: 'Value', default: '0' },
			],
			callback: (feedback) => {
				return drawMeter({
					style: feedback.options.style as MeterStyle,
					thickness: Number(feedback.options.thickness),
					x: Number(feedback.options.x),
					y: Number(feedback.options.y),
					min: Number(feedback.options.min),
					max: Number(feedback.options.max),
					yellowStart: Number(feedback.options.yellowStart),
					redStart: Number(feedback.options.redStart),
					scale: Number(feedback.options.scale),
					value: Number(feedback.options.value),
					width: feedback.image?.width,
					height: feedback.image?.height,
				})
			},
		},
	}
}

export function UpdateFeedbacks(instance: ModuleInstance): void {
	const feedbacks = {
		...buildKeysetFeedbacks(instance, instance.settingDefs),
		...buildLiveStatusFeedbacks(instance),
		...buildKeyStateFeedbacks(instance),
		...buildGatewayFeedbacks(instance),
		...buildMeterFeedbacks(),
	}
	instance.setFeedbackDefinitions(feedbacks as any)
}
