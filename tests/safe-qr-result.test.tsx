import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafeQrResult } from '../components/qr/safe-qr-result';

describe('SafeQrResult', () => {
  it('displays non-Lafiya QR content safely as text with warning', () => {
    render(
      <SafeQrResult
        payload="https://external-untrusted-link.example.com"
        isLafiyaCard={false}
      />
    );

    expect(screen.getByText('Non-Lafiya QR Content')).toBeInTheDocument();
    expect(screen.getByText('https://external-untrusted-link.example.com')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders action button when payload is verified Lafiya card', () => {
    render(
      <SafeQrResult
        payload="https://lafiya.net/card/card_999"
        isLafiyaCard={true}
      />
    );

    expect(screen.getByText('Open Emergency Card')).toBeInTheDocument();
  });
});
