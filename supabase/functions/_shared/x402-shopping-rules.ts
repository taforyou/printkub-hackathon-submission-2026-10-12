import { FILAMENT_COLORS } from '../../../lib/config/printConfig.ts'

export const X402_DEMO_PRODUCT = '458c809e-c99e-473a-8952-8b850fa7fe65'
export const X402_DEMO_SHOP = '645ce058-830f-4f0d-a2a1-8cf69e153fc1'
export const X402_POLICY_CONSENT = 'standing-purchase-v1'
export const availableAgentColors = () => FILAMENT_COLORS.filter(color => color.available && color.material === 'PLA').map(color => color.id)

export function assertDefaultAgentOptions(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('purchase_outside_policy')
  const options = value as Record<string, unknown>
  if (options.materialId !== 'PLA' || options.priceMode !== 'default') throw new Error('purchase_outside_policy')
  const allowed = new Set(availableAgentColors())
  if ('mappings' in options) {
    if (!Array.isArray(options.mappings) || !options.mappings.length || options.mappings.length > 100
      || Object.keys(options).some(key => !['materialId', 'priceMode', 'mappings'].includes(key))) throw new Error('manufacturing_unsupported')
    for (const mapping of options.mappings) {
      if (!mapping || typeof mapping !== 'object' || !allowed.has(mapping.mappedColorId)) throw new Error('physical_color_unavailable')
    }
  } else if (typeof options.colorId !== 'string' || !allowed.has(options.colorId)
    || Object.keys(options).some(key => !['materialId', 'priceMode', 'colorId'].includes(key))) throw new Error('physical_color_unavailable')
}
