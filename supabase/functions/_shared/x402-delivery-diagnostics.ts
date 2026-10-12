// Never forward arbitrary PostgreSQL DETAIL text: it may contain personal data.
const gates = new Set([
  'delivery_snapshot_mismatch',
  'delivery_missing_recipient_name',
  'delivery_missing_line1',
  'delivery_missing_subdistrict',
  'delivery_missing_district',
  'delivery_missing_province',
  'delivery_missing_postal_code',
  'delivery_pickup_details_invalid',
  'delivery_method_invalid',
  'delivery_phone_format_invalid',
])

export function x402DeliveryDiagnostic(detail: unknown): string | null {
  return typeof detail === 'string' && gates.has(detail) ? detail : null
}
