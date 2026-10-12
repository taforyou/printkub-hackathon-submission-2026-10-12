// Order confirmation + ops alert emails, shared by the payment gateway
// confirmation functions (Beam, Max Me, and verified Solana USDC).
// All gateways send the same customer/admin notification.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.99.1'
import {
  DIY_CLICKER_ARTWORK_BUCKET,
  collectPaidDiyClickerArtwork,
} from './diy-clicker-artwork.ts'
import { formatBangkokDateTime } from './bangkok-time.ts'

export const ADMIN_EMAILS = [
  'Printkub.admin@gmail.com',
  'chanon.y@killswitch.finance',
]

// Profile email is optional for LINE users and can contain legacy free text.
// Never let one malformed customer address invalidate the admin copy.
export function isDeliverableEmail(value: string): boolean {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value.trim())
}

const ORDER_HISTORY_URL = 'https://printkub.com/order-history'

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// --- i18n strings (TH/EN) for the order confirmation email ---
// Recipient is the customer (with admins on CC), so wording is neutral and
// customer-facing. Admins still get the same email — they don't need a
// separate ops-language template.
type Locale = 'th' | 'en'

const T = {
  th: {
    headerTitle: 'คำสั่งซื้อ — ชำระเงินแล้ว!',
    headerSubtitle: 'ขอบคุณที่ใช้บริการ PrintKub',
    samedayBannerTitle: '⚡ SAME-DAY DELIVERY',
    samedayBannerDetail: (tier: number | null, fee: string) =>
      `โซน ${tier} · ค่าส่ง ฿${fee} · ส่งภายในวันนี้ 18:00 (ถ้าพิมพ์เสร็จก่อน 14:00)`,
    sectionOrder: '📦 รายละเอียดคำสั่งซื้อ',
    labelOrderNo: 'หมายเลขคำสั่งซื้อ',
    labelAmount: 'ยอดชำระ',
    labelPaymentMethod: 'ช่องทางชำระ',
    labelPaymentDate: 'วันที่ชำระ',
    labelDeliveryMethod: 'วิธีจัดส่ง',
    deliveryPickup: '🏪 รับหน้าร้าน',
    deliveryShipping: '🚚 จัดส่ง',
    sectionCustomer: '👤 ข้อมูลลูกค้า',
    labelName: 'ชื่อ',
    labelEmail: 'อีเมล',
    labelPhone: 'เบอร์โทร',
    placeholderUnknown: 'ไม่ระบุ',
    sectionAddress: '📍 ที่อยู่จัดส่ง',
    sectionItems: '🛒 รายการสินค้า',
    thNo: '#',
    thName: 'ชื่อสินค้า',
    thType: 'ประเภท',
    thQty: 'จำนวน',
    thPrice: 'ราคา',
    specialTags: 'สายคล้องพิเศษ',
    noItems: 'ไม่มีรายการสินค้า',
    sectionAiArtwork: '🎨 ภาพต้นฉบับจาก AI',
    aiArtworkIntro: 'การชำระเงินสำเร็จแล้ว คุณสามารถดาวน์โหลดภาพ PNG ต้นฉบับแบบไม่มีลายน้ำได้ที่ลิงก์ด้านล่าง',
    aiArtworkButton: 'ดาวน์โหลดภาพต้นฉบับ PNG',
    labelSubtotal: 'ยอดรวมสินค้า',
    labelShipping: 'ค่าจัดส่ง',
    labelDiscount: 'ส่วนลด',
    labelGrandTotal: 'ยอดรวมทั้งหมด',
    sectionNotes: '📝 หมายเหตุจากลูกค้า',
    ctaTitle: '🎉 ขอบคุณสำหรับการสั่งซื้อ — ทีมงาน PrintKub กำลังเตรียมการพิมพ์ให้คุณ',
    ctaSubtitle: 'ติดตามสถานะคำสั่งซื้อได้ที่ปุ่มด้านล่าง',
    ctaButton: 'ดูประวัติคำสั่งซื้อ',
    footerAuto: 'ส่งอัตโนมัติจาก PrintKub System — กรุณาอย่าตอบกลับอีเมลนี้',
    subjectPaid: (orderNo: string, amount: string) =>
      `🧾 คำสั่งซื้อ ${orderNo} — ชำระเงินแล้ว ฿${amount}`,
    subjectPaidSameday: (orderNo: string, tier: number | null, amount: string) =>
      `⚡ [URGENT·SAME-DAY·Z${tier}] คำสั่งซื้อ ${orderNo} — ชำระเงินแล้ว ฿${amount}`,
  },
  en: {
    headerTitle: 'Order Confirmed — Payment Received!',
    headerSubtitle: 'Thank you for choosing PrintKub',
    samedayBannerTitle: '⚡ SAME-DAY DELIVERY',
    samedayBannerDetail: (tier: number | null, fee: string) =>
      `Zone ${tier} · Shipping ฿${fee} · Delivers by 18:00 today (if printed before 14:00)`,
    sectionOrder: '📦 Order Details',
    labelOrderNo: 'Order Number',
    labelAmount: 'Amount Paid',
    labelPaymentMethod: 'Payment Method',
    labelPaymentDate: 'Payment Date',
    labelDeliveryMethod: 'Delivery Method',
    deliveryPickup: '🏪 Store Pickup',
    deliveryShipping: '🚚 Shipping',
    sectionCustomer: '👤 Customer Info',
    labelName: 'Name',
    labelEmail: 'Email',
    labelPhone: 'Phone',
    placeholderUnknown: 'N/A',
    sectionAddress: '📍 Shipping Address',
    sectionItems: '🛒 Items',
    thNo: '#',
    thName: 'Product',
    thType: 'Type',
    thQty: 'Qty',
    thPrice: 'Price',
    specialTags: 'Special tags',
    noItems: 'No items',
    sectionAiArtwork: '🎨 Original AI artwork',
    aiArtworkIntro: 'Payment is complete. Download your original unwatermarked PNG using the link below.',
    aiArtworkButton: 'Download original PNG',
    labelSubtotal: 'Subtotal',
    labelShipping: 'Shipping',
    labelDiscount: 'Discount',
    labelGrandTotal: 'Total',
    sectionNotes: '📝 Customer Notes',
    ctaTitle: '🎉 Thank you for your order — the PrintKub team is preparing your print',
    ctaSubtitle: 'Track your order status using the button below',
    ctaButton: 'View Order History',
    footerAuto: 'Sent automatically by PrintKub System — please do not reply to this email',
    subjectPaid: (orderNo: string, amount: string) =>
      `🧾 Order ${orderNo} — Payment Confirmed (฿${amount})`,
    subjectPaidSameday: (orderNo: string, tier: number | null, amount: string) =>
      `⚡ [URGENT·SAME-DAY·Z${tier}] Order ${orderNo} — Payment Confirmed (฿${amount})`,
  },
} as const

// --- Order Confirmation Email ---
// Sent to the customer (TO) with admin ops addresses on CC, so the same
// rendered email satisfies both audiences in a single Resend API call.
// Falls back to admin-only TO when the customer has no email on file
// (LINE-only sign-ins who picked store pickup).
// amountSatang is THB × 100 regardless of gateway — callers whose gateway
// reports THB decimals (Max Me) convert with Math.round(amount * 100).
export async function sendAdminNotification(
  supabaseAdmin: SupabaseClient,
  baseOrderNo: string,
  amountSatang: number,
  methodLabel: string,
  paymentTimeIso: string,
  idempotencyKey?: string,
) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY not set')
  }

  // Fetch order details
  const { data: job } = await supabaseAdmin
    .from('print_jobs')
    .select('*')
    .eq('job_number', baseOrderNo)
    .single()

  if (!job) {
    throw new Error(`sendAdminNotification: job not found for ${baseOrderNo}`)
  }

  // Fetch order items with file info
  const { data: items } = await supabaseAdmin
    .from('print_job_items')
    .select('*, files(original_filename, thumbnail_path, metadata)')
    .eq('job_id', job.id)
    .order('created_at', { ascending: true })

  // Fetch customer profile (locale included; will be undefined until the
  // 004_user_locale.sql migration is deployed — handled by clamp below).
  const { data: customer } = await supabaseAdmin
    .from('user_profiles')
    .select('display_name, email, phone, picture_url, locale')
    .eq('id', job.user_id)
    .single()

  // Robust locale resolution: anything not 'en' → 'th' (the project default).
  const localeRaw = (customer as { locale?: unknown } | null)?.locale
  const locale: Locale = localeRaw === 'en' ? 'en' : 'th'
  const t = T[locale]

  const amountThb = (amountSatang / 100).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  // Bangkok wall-clock. Offset-less gateway strings are Asia/Bangkok, not UTC.
  const formattedPaymentDate = formatBangkokDateTime(paymentTimeIso)

  // Same-day delivery details (may be null for standard orders)
  const isSameday = job.sameday_tier != null
  const samedayTier = job.sameday_tier as number | null
  const samedayFeeBaht = Number(job.sameday_fee || 0).toLocaleString('th-TH', { minimumFractionDigits: 2 })

  const samedayBannerHtml = isSameday ? `
    <div style="background: #dc2626; color: white; padding: 16px; border-radius: 8px; margin-bottom: 16px; text-align: center; box-shadow: 0 2px 6px rgba(220,38,38,0.3);">
      <p style="margin: 0; font-size: 20px; font-weight: bold;">${t.samedayBannerTitle}</p>
      <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.95;">
        ${t.samedayBannerDetail(samedayTier, samedayFeeBaht)}
      </p>
    </div>
  ` : ''

  // Internal special-tag rows are grouped under their printable parent. This
  // keeps product quantities and paid accessory color counts unambiguous for
  // both the customer and the operations team copied on this email.
  const allItems = (items || []) as Record<string, unknown>[]
  const printableItems = allItems.filter(item => !item.special_tag_parent_item_id)
  const itemsHtml = printableItems.map((item: Record<string, unknown>, i: number) => {
    const tagCounts = new Map<string, number>()
    if (item.tag_type === 'special' && item.special_tag_color) {
      tagCounts.set(String(item.special_tag_color), Number(item.quantity) || 1)
    }
    let accessoryTotal = 0
    for (const accessory of allItems) {
      if (accessory.special_tag_parent_item_id !== item.id) continue
      const color = String(accessory.special_tag_color || '')
      if (color) tagCounts.set(color, (tagCounts.get(color) || 0) + (Number(accessory.quantity) || 1))
      accessoryTotal += Number(accessory.total_price) || 0
    }
    const tagSummary = Array.from(tagCounts.entries())
      .map(([color, quantity]) => `${escapeHtml(color)} ×${quantity}`)
      .join(', ')
    const combinedTotal = (Number(item.total_price) || 0) + accessoryTotal
    return `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 8px; text-align: center;">${i + 1}</td>
      <td style="padding: 8px;">
        ${escapeHtml(item.product_name as string) || t.placeholderUnknown}
        ${tagSummary ? `<div style="font-size: 11px; color: #c2410c; margin-top: 3px;">${t.specialTags}: ${tagSummary}</div>` : ''}
      </td>
      <td style="padding: 8px;">${escapeHtml(item.product_type as string) || '-'}</td>
      <td style="padding: 8px; text-align: center;">${item.quantity || 1}</td>
      <td style="padding: 8px; text-align: right;">฿${combinedTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
    </tr>
  `
  }).join('')

  const paidArtworkCandidates = collectPaidDiyClickerArtwork(
    { id: job.id as string, user_id: job.user_id as string | null },
    (items || []) as unknown[],
    (storagePath) => storagePath,
  )
  const paidArtwork = (await Promise.all(
    paidArtworkCandidates.map(async (artwork) => {
      const { data, error } = await supabaseAdmin.storage
        .from(DIY_CLICKER_ARTWORK_BUCKET)
        .createSignedUrl(artwork.storagePath, 7 * 24 * 60 * 60, {
          download: artwork.label,
        })
      if (error || !data?.signedUrl) {
        console.error('Failed to sign paid DIY Clicker artwork:', error?.message)
        return null
      }
      return { ...artwork, publicUrl: data.signedUrl }
    }),
  )).filter((artwork): artwork is NonNullable<typeof artwork> => artwork !== null)
  const aiArtworkHtml = paidArtwork.length > 0 ? `
    <div style="background: #eff6ff; border: 1px solid #bfdbfe; padding: 18px; border-radius: 8px; margin: 18px 0;">
      <h3 style="color: #1d4ed8; margin: 0 0 8px;">${t.sectionAiArtwork}</h3>
      <p style="margin: 0 0 14px; color: #374151; line-height: 1.5;">${t.aiArtworkIntro}</p>
      ${paidArtwork.map((artwork, index) => `
        <div style="${index > 0 ? 'border-top: 1px solid #bfdbfe; padding-top: 14px; margin-top: 14px;' : ''}">
          <p style="margin: 0 0 8px; font-size: 13px; color: #4b5563;">${escapeHtml(artwork.label)}</p>
          <a href="${escapeHtml(artwork.publicUrl)}" style="display: inline-block; background: #1d4ed8; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 999px; font-weight: bold; font-size: 14px;">${t.aiArtworkButton} →</a>
          <p style="margin: 8px 0 0; font-size: 11px; overflow-wrap: anywhere;">
            <a href="${escapeHtml(artwork.publicUrl)}" style="color: #1d4ed8; text-decoration: underline;">${escapeHtml(artwork.publicUrl)}</a>
          </p>
        </div>
      `).join('')}
    </div>
  ` : ''

  // Build shipping address
  const addressParts = [
    job.shipping_address_line1,
    job.shipping_address_line2,
    job.shipping_subdistrict,
    job.shipping_district,
    job.shipping_province,
    job.shipping_postal_code,
  ].filter(Boolean)
  const shippingAddress = addressParts.length > 0 ? addressParts.join(', ') : t.placeholderUnknown

  const customerName = (job.recipient_name as string) || (customer?.display_name as string) || ''
  const customerEmail = (customer?.email as string) || ''
  const validCustomerEmail = isDeliverableEmail(customerEmail) ? customerEmail.trim() : ''
  const customerPhoneDisplay = (job.contact_phone as string) || (customer?.phone as string) || ''

  const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: 'Prompt', 'Segoe UI', Tahoma, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="background: #FF6600; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 24px;">🧾 ${t.headerTitle}</h1>
    <p style="margin: 8px 0 0; font-size: 14px; opacity: 0.9;">${t.headerSubtitle}</p>
  </div>

  <div style="border: 1px solid #ddd; border-top: none; padding: 20px; border-radius: 0 0 8px 8px;">
    ${samedayBannerHtml}
    <h2 style="color: #FF6600; margin-top: 0;">${t.sectionOrder}</h2>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr><td style="padding: 6px 0; font-weight: bold; width: 140px;">${t.labelOrderNo}:</td><td style="padding: 6px 0; color: #FF6600; font-weight: bold;">${escapeHtml(baseOrderNo)}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelAmount}:</td><td style="padding: 6px 0; color: #16a34a; font-weight: bold; font-size: 18px;">฿${amountThb}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelPaymentMethod}:</td><td style="padding: 6px 0;">${escapeHtml(methodLabel)}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelPaymentDate}:</td><td style="padding: 6px 0;">${escapeHtml(formattedPaymentDate)}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelDeliveryMethod}:</td><td style="padding: 6px 0;">${
        isSameday
          ? `<span style="color: #dc2626; font-weight: bold;">⚡ SAME-DAY · Zone ${samedayTier} · ฿${samedayFeeBaht}</span>`
          : job.delivery_method === 'pickup' ? t.deliveryPickup : t.deliveryShipping
      }</td></tr>
    </table>

    <h3 style="color: #FF6600; border-bottom: 2px solid #FF6600; padding-bottom: 4px;">${t.sectionCustomer}</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr><td style="padding: 6px 0; font-weight: bold; width: 140px;">${t.labelName}:</td><td style="padding: 6px 0;">${escapeHtml(customerName) || t.placeholderUnknown}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelEmail}:</td><td style="padding: 6px 0;">${escapeHtml(validCustomerEmail) || t.placeholderUnknown}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelPhone}:</td><td style="padding: 6px 0;">${escapeHtml(customerPhoneDisplay) || t.placeholderUnknown}</td></tr>
    </table>

    <h3 style="color: #FF6600; border-bottom: 2px solid #FF6600; padding-bottom: 4px;">${t.sectionAddress}</h3>
    <p style="margin: 8px 0 16px; line-height: 1.6;">${escapeHtml(shippingAddress)}</p>

    <h3 style="color: #FF6600; border-bottom: 2px solid #FF6600; padding-bottom: 4px;">${t.sectionItems}</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <thead>
        <tr style="background: #f9f9f9;">
          <th style="padding: 8px; text-align: center; font-size: 13px;">${t.thNo}</th>
          <th style="padding: 8px; text-align: left; font-size: 13px;">${t.thName}</th>
          <th style="padding: 8px; text-align: left; font-size: 13px;">${t.thType}</th>
          <th style="padding: 8px; text-align: center; font-size: 13px;">${t.thQty}</th>
          <th style="padding: 8px; text-align: right; font-size: 13px;">${t.thPrice}</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml || `<tr><td colspan="5" style="padding: 8px; text-align: center; color: #999;">${t.noItems}</td></tr>`}
      </tbody>
    </table>

    ${aiArtworkHtml}

    ${(() => {
      const subtotal = Number(job.total_price || 0)
      const shipping = Number(job.shipping_cost || 0)
      const discount = Number(job.discount_amount || 0)
      const grandTotal = Math.max(0, subtotal + shipping - discount)
      const couponCodes = Array.isArray(job.coupon_codes) && job.coupon_codes.length > 0
        ? (job.coupon_codes as string[]).join(', ')
        : (job.coupon_code as string | null) || ''
      const fmt = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2 })
      return `
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelSubtotal}:</td><td style="padding: 6px 0; text-align: right;">฿${fmt(subtotal)}</td></tr>
      <tr><td style="padding: 6px 0; font-weight: bold;">${t.labelShipping}:</td><td style="padding: 6px 0; text-align: right;">฿${fmt(shipping)}</td></tr>
      ${discount > 0 ? `<tr><td style="padding: 6px 0; font-weight: bold; color: #dc2626;">${t.labelDiscount}${couponCodes ? ` (${escapeHtml(couponCodes)})` : ''}:</td><td style="padding: 6px 0; text-align: right; color: #dc2626;">-฿${fmt(discount)}</td></tr>` : ''}
      <tr style="border-top: 2px solid #FF6600;"><td style="padding: 10px 0; font-weight: bold; font-size: 16px;">${t.labelGrandTotal}:</td><td style="padding: 10px 0; text-align: right; font-weight: bold; font-size: 18px; color: #FF6600;">฿${fmt(grandTotal)}</td></tr>
    </table>`
    })()}

    ${job.notes ? `
    <h3 style="color: #FF6600; border-bottom: 2px solid #FF6600; padding-bottom: 4px;">${t.sectionNotes}</h3>
    <p style="margin: 8px 0 16px; background: #fff8f0; padding: 12px; border-radius: 4px; border-left: 3px solid #FF6600;">${escapeHtml(job.notes as string)}</p>
    ` : ''}

    <div style="background: #fff3e0; padding: 20px; border-radius: 8px; margin-top: 16px; text-align: center;">
      <p style="margin: 0; font-weight: bold; color: #e65100; font-size: 15px;">${t.ctaTitle}</p>
      <p style="margin: 8px 0 16px; font-size: 13px; color: #666;">${t.ctaSubtitle}</p>
      <a href="${ORDER_HISTORY_URL}" style="display: inline-block; background: #FF6600; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 999px; font-weight: bold; font-size: 14px;">${t.ctaButton} →</a>
      <p style="margin: 12px 0 0; font-size: 12px; color: #999;"><a href="${ORDER_HISTORY_URL}" style="color: #FF6600; text-decoration: underline;">${ORDER_HISTORY_URL}</a></p>
    </div>
  </div>

  <p style="text-align: center; color: #999; font-size: 12px; margin-top: 16px;">
    ${t.footerAuto}
  </p>
</body>
</html>`

  // --- Recipient strategy ---
  // 1 Resend API call regardless of whether the buyer has an email.
  //   - Has email  → TO: customer, CC: admins (one billable send)
  //   - No email   → TO: admins only (preserves the original behavior exactly)
  const hasCustomerEmail = validCustomerEmail.length > 0
  if (customerEmail.trim() && !hasCustomerEmail) {
    console.warn(`Invalid customer email for ${baseOrderNo}; sending to admins only`)
  }

  const subject = isSameday
    ? t.subjectPaidSameday(baseOrderNo, samedayTier, amountThb)
    : t.subjectPaid(baseOrderNo, amountThb)

  const payload: {
    from: string
    to: string[]
    cc?: string[]
    subject: string
    html: string
  } = {
    from: 'PrintKub <no-reply@mail.printkub.com>',
    to: hasCustomerEmail ? [validCustomerEmail] : ADMIN_EMAILS,
    subject,
    html: emailHtml,
  }
  if (hasCustomerEmail) {
    payload.cc = ADMIN_EMAILS
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  })

  if (!res.ok) {
    const errBody = await res.text()
    console.error('Resend API error:', res.status, errBody)
    throw new Error(`Resend API rejected order ${baseOrderNo}: ${res.status}`)
  } else {
    const recipients = hasCustomerEmail
      ? `to=${validCustomerEmail}, cc=${ADMIN_EMAILS.join(', ')}`
      : `to=${ADMIN_EMAILS.join(', ')} (no customer email on file)`
    console.log(`Order email sent for ${baseOrderNo} [locale=${locale}] — ${recipients}`)
  }
}

// --- Ops alert for a double payment (two charges succeeded for one order) ---
// Neither gateway supports API refunds for a completed QR payment, so this
// needs a manual refund — the alert goes to admins only. refundNoteHtml
// carries the gateway-specific refund instructions.
export async function sendDoublePaymentAlert(
  baseOrderNo: string,
  newChargeId: string,
  existingChargeId: string,
  amountSatang: number,
  refundNoteHtml: string = `QR PromptPay refunds are not supported via Beam's API — refund the duplicate manually
        via <a href="https://lighthouse.beamcheckout.com">Lighthouse</a> / bank transfer.`,
) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  if (!resendApiKey) {
    throw new Error(`RESEND_API_KEY not set for double-payment alert ${baseOrderNo}`)
  }
  const amountThb = (amountSatang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2 })
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'PrintKub <no-reply@mail.printkub.com>',
      to: ADMIN_EMAILS,
      subject: `⚠️ [DOUBLE PAYMENT] Order ${baseOrderNo} paid twice — manual refund needed`,
      html: `
        <p><strong>Order ${escapeHtml(baseOrderNo)} received a second successful payment.</strong></p>
        <p>New charge: <code>${escapeHtml(newChargeId)}</code> (฿${amountThb})<br>
        Earlier successful charge: <code>${escapeHtml(existingChargeId)}</code></p>
        <p>${refundNoteHtml}</p>`,
    }),
  })
  if (!res.ok) {
    console.error('Resend double-payment alert error:', res.status, await res.text())
    throw new Error(`Resend API rejected double-payment alert ${baseOrderNo}: ${res.status}`)
  } else {
    console.log(`Double-payment alert sent for ${baseOrderNo} (${newChargeId} vs ${existingChargeId})`)
  }
}
