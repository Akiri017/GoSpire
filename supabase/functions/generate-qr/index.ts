/// <reference types="https://deno.land/x/types/deploy/deploy.d.ts" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// CORS headers to allow your mobile app to call this
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { orderId, amount } = await req.json()

    // 1. Create Payment Intent with PayRex
    const response = await fetch('https://api-sandbox.payrex.ph/api/v1/payment_intents', { // check specific endpoint in PayRex docs
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(Deno.env.get('PAYREX_SECRET_KEY') + ':')}`, // Basic Auth often used
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amount * 100, // Convert PHP to Centavos
        currency: 'PHP',
        description: `Order #${orderId}`,
        payment_methods: ['qrph'],
        metadata: { order_id: orderId } // CRITICAL: This links the webhook back to the order
      }),
    })

    const data = await response.json()
    console.log("PayRex Response:", data)

    if (!response.ok) throw new Error(JSON.stringify(data))

    // 2. Extract QR Code URL
    // Note: Adjust path based on exact PayRex response structure. 
    // Often it is data.next_action.qr_code.image_url_png or similar.
    // For now we assume standard structure:
    const qrUrl = data.next_action?.qr_code?.image_url_png || data.payment_method_options?.qrph?.qr_code_url;

    return new Response(
      JSON.stringify({ qr_url: qrUrl, payrex_id: data.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    })
  }
})