import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { shoppingHandler } from '../_shared/x402-shopping.ts'
serve(shoppingHandler(false))
