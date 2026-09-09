import { NextRequest, NextResponse } from 'next/server';

import { stripeKey, stripeConfigured } from '@/lib/billing/stripe';

const TIMEOUT_MS = 10_000;

export async function POST(request: NextRequest) {
  try {
    if (!stripeConfigured()) {
      return NextResponse.json(
        { error: 'Stripe is not configured' },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { subscriptionId } = body;

    if (!subscriptionId) {
      return NextResponse.json(
        { error: 'subscriptionId is required' },
        { status: 400 }
      );
    }

    const key = stripeKey();

    // Immediate cancellation (DELETE request)
    const response = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Stripe API error:', errorData);
      return NextResponse.json(
        { error: errorData.error?.message || 'Failed to cancel subscription' },
        { status: response.status }
      );
    }

    const subscription = await response.json();

    return NextResponse.json({
      success: true,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_end: subscription.current_period_end,
      },
    });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    return NextResponse.json(
      { error: 'Failed to cancel subscription' },
      { status: 500 }
    );
  }
}
