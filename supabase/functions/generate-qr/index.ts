// Ambient Deno declarations for Supabase Edge Functions
declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => void;
  env: {
    get: (key: string) => string | undefined;
  };
};

// CORS headers to allow your mobile app to call this
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // QR expiry time in minutes (configurable)
  const QR_EXPIRY_MINUTES = 5;

  try {
    const { orderId, amount } = await req.json()
    const expiresAt = new Date(Date.now() + QR_EXPIRY_MINUTES * 60 * 1000);
    const generatedAt = new Date();

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
      JSON.stringify({ 
        qr_url: qrUrl, 
        payrex_id: data.id,
        generated_at: generatedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        expires_in_seconds: QR_EXPIRY_MINUTES * 60
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    console.error('PayRex API Error:', error);
    
    // Fallback: Generate QR using free service when PayRex is unavailable
    // Parse request body again for fallback
    let orderId: string;
    let amount: number;
    
    try {
      const body = await req.clone().json();
      orderId = body.orderId;
      amount = body.amount;
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }
    
    const expiresAt = new Date(Date.now() + QR_EXPIRY_MINUTES * 60 * 1000);
    const generatedAt = new Date();
    
    const fallbackData = {
      merchant: 'Rider App',
      order_id: orderId,
      amount: amount,
      currency: 'PHP',
      payment_type: 'QRPH'
    };
    
    const fallbackQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(JSON.stringify(fallbackData))}`;
    
    return new Response(
      JSON.stringify({ 
        qr_url: fallbackQrUrl,
        payrex_id: `fallback_${orderId}_${Date.now()}`,
        generated_at: generatedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        expires_in_seconds: QR_EXPIRY_MINUTES * 60,
        test_mode: true,
        message: 'PayRex API unavailable. Using fallback QR generation.'
      }),
      { 
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      }
    );
  }
})