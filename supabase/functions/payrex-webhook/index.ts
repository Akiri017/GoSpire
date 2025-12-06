import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req: Request) => {
  try {
    const event = await req.json()
    console.log("Webhook received:", event.type)

    // 1. Initialize Supabase Admin Client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 2. Handle Successful Payment
    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object
      const orderId = paymentIntent.metadata.order_id

      console.log(`Payment confirmed for Order: ${orderId}`)

      // 3. Update Database
      const { error } = await supabase
        .from('orders')
        .update({ 
          status: 'PAID', 
          payment_method: 'QRPH',
          payrex_id: paymentIntent.id 
        })
        .eq('id', orderId)

      if (error) throw error
    }

    return new Response(JSON.stringify({ received: true }), { status: 200 })
  } catch (err) {
    console.error(err)
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    return new Response(JSON.stringify({ error: errorMessage }), { status: 400 })
  }
})