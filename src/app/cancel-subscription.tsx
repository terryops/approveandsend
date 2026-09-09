'use client';

import { useState } from 'react';

interface CancelSubscriptionProps {
  subscriptionId: string;
  labels: {
    cancel: string;
    canceled: string;
    title: string;
    body: string;
    confirm: string;
    canceling: string;
    back: string;
  };
}

export function CancelSubscription({ subscriptionId, labels }: CancelSubscriptionProps) {
  const [showModal, setShowModal] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [isCanceled, setIsCanceled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCancel = async () => {
    setIsCanceling(true);
    setError(null);

    try {
      const response = await fetch('/api/stripe/cancel-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to cancel subscription');
      }

      setIsCanceled(true);
      setShowModal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel subscription');
    } finally {
      setIsCanceling(false);
    }
  };

  if (isCanceled) {
    return <span className="meta" style={{ color: 'var(--wrong)' }}>{labels.canceled}</span>;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowModal(true)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--wrong)',
          cursor: 'pointer',
          fontSize: 'inherit',
          textDecoration: 'underline',
        }}
      >
        {labels.cancel}
      </button>

      {showModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => !isCanceling && setShowModal(false)}
        >
          <div
            className="card"
            style={{
              maxWidth: 400,
              padding: '1.5rem',
            }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 1rem' }}>{labels.title}</h3>
            <p style={{ margin: '0 0 1rem' }}>{labels.body}</p>

            {error && (
              <p style={{ color: 'var(--wrong)', margin: '0 0 1rem' }}>{error}</p>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="button-link"
                onClick={() => setShowModal(false)}
                disabled={isCanceling}
              >
                {labels.back}
              </button>
              <button
                type="button"
                className="danger"
                onClick={handleCancel}
                disabled={isCanceling}
              >
                {isCanceling ? labels.canceling : labels.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
