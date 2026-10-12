# PrintKub: wallet authentication and agent payments extension

Local hackathon review snapshot — 12 October 2026.

This package contains selected implementation source for wallet authentication, x402 V2 payments, and a constrained payment agent integrated into the existing PrintKub 3D-printing marketplace. It is an extension of PrintKub and cannot run standalone. The original storefront, builders, product assets, other payment gateways, and full database baseline are intentionally outside this submission copy.

## Why this extension is needed

PrintKub already turns a configured 3D product into a priced order, payment record and physical fulfillment workflow. An agent needs a way to authenticate its wallet, act within explicit customer spending permission, pay a precise order, and deliver a trustworthy paid result into that existing workflow. A wallet transfer alone does not establish who authorized a purchase, which product and address were approved, or whether the same order was already paid.

This extension adds wallet identity, customer-controlled spending policies, immutable order-specific quotes, x402 payment challenges, constrained signing, payment reservations and recovery. These connect agent purchases to the ordinary PrintKub order/admin process while keeping payment secrets and signing keys out of the browser and model runtime.

Here “extension” means an application integration, not a browser extension or a separate marketplace.

## Submission scope and provenance

The source tree preserves original paths and source bytes. SOURCE_MANIFEST.json lists each included file, its SHA-256 digest and the original checkout HEAD. HOST_DEPENDENCIES.txt lists referenced host modules intentionally omitted.

The submission focus is the wallet/x402/agent integration. Existing shared authentication, exchange-rate, Solana validation and order-email helpers are included only as supporting dependencies. Migrations 037–038 and 040–041 are integration foundations; 042–052 implement the x402 evolution. Migration 052 is authoritative for the current funding model: the agent pays USDC for products and delivery; sponsorship covers SOL network fees only. Older treasury/product-funding branches and columns remain as historical context, not the current behavior.

A snapshot does not prove hackathon authorship or dates. Before pushing, the owner must confirm which included work was written during the hackathon, disclose pre-existing dependencies, and remove any material outside the event's permitted scope. This package does not claim that the whole PrintKub platform was built during the event.

## Code map

| Area | Files | Purpose |
| --- | --- | --- |
| Browser wallet login | lib/dynamic/, components/auth/Dynamic*.tsx | Dynamic wallet SDK initialization and wallet login UI |
| Customer authentication | supabase/functions/authenticate-dynamic-user/, _shared/dynamic-*.ts | Verify provider token and exchange into the host's Supabase identity |
| Agent authentication | supabase/functions/authenticate-x402-agent/ | Signed wallet challenge and linked-agent session |
| Customer permissions | components/payment/Agent*.tsx, lib/payment/x402Permissions.ts, supabase/functions/x402-permissions/ | Wallet linking, bounded standing permission, revocation and legacy per-order approval |
| Agent shopping | supabase/functions/agent-catalog/, x402-purchase/, _shared/x402-shopping*.ts | Constrained catalog and delegated checkout under prior consent |
| x402 settlement | supabase/functions/x402-pay/, _shared/x402-quote.ts, x402-facilitator.ts, x402-solana.ts, x402-payment-rules.ts | Exact payment requirements, transaction checks and finalized payment handling |
| Recovery | supabase/functions/x402-reconcile/, _shared/x402-recovery*.ts | Recover pending settlement without blindly charging again |
| Isolated signer | tools/x402-agent/ | Owner-run Deno agent; signing keys stay outside browser/model runtime |
| Authorization/accounting | supabase/migrations/ | Ordered incremental schema, RPC, RLS, budget and settlement controls |

## Purchase flow

1. A customer authenticates with PrintKub and links the agent's wallet. Wallet verification proves ownership; it does not grant spending authority.
2. The customer explicitly creates a bounded standing policy: supported product/options, delivery details, recipient, expiry, order count and USDC limits. The agent cannot raise those limits.
3. The agent signs a fresh login challenge, reads the supported catalog and requests a qualifying purchase using a persistent request ID.
4. The backend validates the customer's policy, prepares an ordinary host order, freezes its quote/snapshot and atomically issues an order-specific payment grant.
5. The agent validates the x402 V2 challenge and constructs/signs the allowed Solana transaction. The agent pays product/delivery USDC; an enabled sponsor pays only SOL network fees.
6. Settlement is reconciled against finalized chain evidence before the normal order/payment state is confirmed. Pending responses remain pending and reuse the existing journal/request rather than starting a second payment.

FLOW_PSEUDOCODE.txt is an explanatory sketch, not executable source. The actual implementation is in the files above. AgentPaymentApproval includes the earlier per-order path; standing-policy shopping is the current automatic purchase direction.

## Why this cannot run standalone

The frontend imports PrintKub's Supabase client, session/locale/theme providers, database types and product configuration. The backend relies on existing users, profiles, catalog/storage records, print_jobs, order items, checkout/pricing RPCs, RLS and ordinary fulfillment/payment accounting. Included migrations modify that existing schema rather than creating a new complete application.

The runner additionally needs an activated PrintKub Supabase backend, an enrolled wallet, explicit customer permission, a configured supported Solana Devnet USDC payment route, provider/RPC access and private operator configuration. Even though it is a separate process, it is a client of PrintKub's APIs and cannot independently create or fulfill a PrintKub order.

To integrate this snapshot, an operator must use the complete compatible host code and ordered database migration history, restore the omitted host dependencies, install the host/Deno dependencies, configure Dynamic and the Supabase functions, configure the supported payment path and recovery identity, and obtain fresh customer consent. Do not apply these migrations to an empty database or launch the excerpt as a standalone Next.js app. Runtime activation and paid-order acceptance must be completed by the owner in the host environment.

## Current evidence and limits

The existing project documentation records owner-confirmed successful linked-wallet authentication on 12 October 2026 and owner-reported human crypto checkout success. This proves neither agent settlement nor autonomous purchase acceptance. Standing-policy/catalog/delegated-checkout and fee sponsorship are implemented in local source; successful agent-paid order/admin evidence remains pending in the provided record. Current supported scope is Solana Devnet USDC and the constrained default-theme/plain-file Ferris product flow. Mainnet, EVM settlement and unrestricted autonomous shopping are not claimed.

Packaging changes no application behavior. Source files were copied unchanged; no runtime tests, migrations, deployments, wallet actions or payments were performed for this submission package. No populated environment files, private wallet keys, state journals, Git history, dependencies or generated build output are included.

## GitHub submission and judge access

The owner will manually push this folder to a dedicated GitHub repository. No repository was created, pushed or shared by the coding agent, and no direct URL is available from the source checkout.

Submit the actual direct repository URL in the form https://github.com/OWNER/REPOSITORY. Replace OWNER/REPOSITORY with the real destination after pushing; this example is not a submission link. Do not submit a profile, organization URL, local folder or ZIP in place of the required repository link.

For a public repository, confirm the actual repository and source files can be opened while signed out. For a private repository, use GitHub's repository access settings to invite hackathon@colosseum.com as requested by the hackathon. Confirm the invitation resolves to the intended judge account, and that access is accepted/active with permission to read the code. If GitHub cannot resolve the email, obtain the judges' GitHub account from the organizer rather than guessing. A pending invitation is not evidence that the judges can already access the repository.

Only submit once the real repository has the code and the judges can access it. This package deliberately leaves the access step to the owner; judge access has not been verified.
