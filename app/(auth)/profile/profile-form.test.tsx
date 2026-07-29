import { render, screen } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

// Mock env variables before they are parsed by lib/env / lib/env-server.
// serverEnv lives in lib/env-server.ts (not lib/env.ts), so it needs its own
// mock rather than being folded into the @/lib/env mock.
vi.mock("@/lib/env", () => ({
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  },
}));
vi.mock("@/lib/env-server", () => ({
  serverEnv: {
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    STELLAR_NETWORK_PASSPHRASE: "test-passphrase",
    SOROBAN_RPC_URL: "http://localhost:8000",
  },
}));

import { ProfileForm } from "./profile-form";

// Mock useActionState from React
const mockUseActionState = vi.fn();
vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return {
    ...original,
    useActionState: (action: unknown, initialState: unknown) =>
      mockUseActionState(action, initialState),
  };
});

describe("ProfileForm Accessibility", () => {
  it("renders without errors initially", () => {
    mockUseActionState.mockReturnValue([undefined, vi.fn(), false]);
    render(<ProfileForm profile={null} userId="user-123" />);

    const nameInput = screen.getByLabelText(/full name/i);
    expect(nameInput).not.toHaveAttribute("aria-invalid");
    expect(nameInput).not.toHaveAttribute("aria-describedby");
  });

  it("associates inputs with validation errors via aria-invalid and aria-describedby", () => {
    mockUseActionState.mockReturnValue([
      {
        error: "Name is required",
        errors: {
          name: "Name is required",
          dateOfBirth: "Enter a valid date",
          bloodGroup: "Invalid blood group",
          allergies: "Allergies list error",
          emergencyContacts: "Invalid emergency contacts",
        },
      },
      vi.fn(),
      false,
    ]);

    const { container } = render(<ProfileForm profile={null} userId="user-123" />);

    // Check name input
    const nameInput = screen.getByLabelText(/full name/i);
    expect(nameInput).toHaveAttribute("aria-invalid", "true");
    expect(nameInput).toHaveAttribute("aria-describedby", "name-error");
    expect(container.querySelector("#name-error")).toHaveTextContent("Name is required");

    // Check date of birth input
    const dobInput = screen.getByLabelText(/date of birth/i);
    expect(dobInput).toHaveAttribute("aria-invalid", "true");
    expect(dobInput).toHaveAttribute("aria-describedby", "dateOfBirth-error");
    expect(container.querySelector("#dateOfBirth-error")).toHaveTextContent("Enter a valid date");

    // Check blood group select
    const bloodSelect = screen.getByLabelText(/blood group/i);
    expect(bloodSelect).toHaveAttribute("aria-invalid", "true");
    expect(bloodSelect).toHaveAttribute("aria-describedby", "bloodGroup-error");
    expect(container.querySelector("#bloodGroup-error")).toHaveTextContent("Invalid blood group");

    // Check allergies inputs (represented inside TagListField)
    const allergiesInput = screen.getByPlaceholderText(/e\.g\. Penicillin/i);
    expect(allergiesInput).toHaveAttribute("aria-invalid", "true");
    expect(allergiesInput).toHaveAttribute("aria-describedby", "allergies-error");
    expect(container.querySelector("#allergies-error")).toHaveTextContent("Allergies list error");

    // Check emergency contacts inputs
    const contactNameInput = screen.getByPlaceholderText(/name/i);
    expect(contactNameInput).toHaveAttribute("aria-invalid", "true");
    expect(contactNameInput).toHaveAttribute("aria-describedby", "emergencyContacts-error");
    expect(container.querySelector("#emergencyContacts-error")).toHaveTextContent(
      "Invalid emergency contacts",
    );
  });

  it("announces general form validation error using role='alert'", () => {
    mockUseActionState.mockReturnValue([
      {
        error: "Please correct the errors below.",
      },
      vi.fn(),
      false,
    ]);

    render(<ProfileForm profile={null} userId="user-123" />);

    const alertMessage = screen.getByRole("alert");
    expect(alertMessage).toHaveTextContent("Please correct the errors below.");
  });

  it("announces success message using role='status'", () => {
    mockUseActionState.mockReturnValue([
      {
        success: true,
      },
      vi.fn(),
      false,
    ]);

    render(<ProfileForm profile={null} userId="user-123" />);

    const statusMessage = screen.getByRole("status");
    expect(statusMessage).toHaveTextContent("Saved.");
  });
});
