// Match x402_saved_delivery() in migration 050. Remove display separators only;
// retain other characters so SQL rejects malformed/non-domestic phone numbers.
export function normalizeX402DeliveryPhone(phone: string | null | undefined): string | null {
  return phone == null ? null : phone.replace(/[ -]/g, '')
}
