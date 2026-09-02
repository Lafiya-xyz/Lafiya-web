/**
 * Tests for app/(auth)/profile/tag-list-field.tsx
 *
 * Covers: empty-list initial state, adding tags, editing tags,
 * removing one tag while leaving others intact, and error display.
 * TagListField is the shared component for allergies, medications, and
 * chronic conditions — bugs here have outsized blast radius.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { TagListField } from "@/app/(auth)/profile/tag-list-field";

// ---- helpers ----

function getInputs(name: string): HTMLInputElement[] {
  // Each input shares the `name` prop so the server action can getAll().
  return Array.from(
    document.querySelectorAll(`input[name="${name}"]`),
  ) as HTMLInputElement[];
}

function removeButtons(label: string): HTMLButtonElement[] {
  return screen.getAllByRole("button", {
    name: new RegExp(`remove ${label}`, "i"),
  }) as HTMLButtonElement[];
}

const defaultProps = {
  name: "allergies",
  label: "Allergies",
  placeholder: "e.g. Penicillin",
};

// ---- empty-list state ----

describe("TagListField — empty-list initial state", () => {
  it("renders one empty input when initialValues is empty", () => {
    render(<TagListField {...defaultProps} initialValues={[]} />);
    const inputs = getInputs("allergies");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe("");
  });

  it("disables the remove button on the sole row", () => {
    render(<TagListField {...defaultProps} initialValues={[]} />);
    const [btn] = removeButtons("allergies");
    expect(btn).toBeDisabled();
  });
});

// ---- initial values ----

describe("TagListField — initial values", () => {
  it("renders provided values in order", () => {
    render(
      <TagListField
        {...defaultProps}
        initialValues={["Penicillin", "Sulfa"]}
      />,
    );
    const inputs = getInputs("allergies");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("Penicillin");
    expect(inputs[1].value).toBe("Sulfa");
  });
});

// ---- adding a tag ----

describe("TagListField — adding a tag", () => {
  it("appends an empty row when '+ Add ...' is clicked", () => {
    render(
      <TagListField {...defaultProps} initialValues={["Penicillin"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add allergies/i }));
    const inputs = getInputs("allergies");
    expect(inputs).toHaveLength(2);
    expect(inputs[1].value).toBe("");
  });

  it("existing tags are preserved after adding a new row", () => {
    render(
      <TagListField {...defaultProps} initialValues={["Penicillin"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add allergies/i }));
    expect(getInputs("allergies")[0].value).toBe("Penicillin");
  });

  it("typed value in a new row is reflected in the input", () => {
    render(<TagListField {...defaultProps} initialValues={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /add allergies/i }));
    const inputs = getInputs("allergies");
    fireEvent.change(inputs[1], { target: { value: "Sulfa" } });
    expect(getInputs("allergies")[1].value).toBe("Sulfa");
  });
});

// ---- editing a tag ----

describe("TagListField — editing a tag", () => {
  it("editing one tag does not alter adjacent tags", () => {
    render(
      <TagListField
        {...defaultProps}
        initialValues={["Penicillin", "Sulfa", "Aspirin"]}
      />,
    );
    fireEvent.change(getInputs("allergies")[1], {
      target: { value: "Codeine" },
    });
    const inputs = getInputs("allergies");
    expect(inputs[0].value).toBe("Penicillin"); // untouched
    expect(inputs[1].value).toBe("Codeine");   // edited
    expect(inputs[2].value).toBe("Aspirin");   // untouched
  });
});

// ---- removing a tag ----

describe("TagListField — removing a tag", () => {
  it("enables remove buttons when more than one tag exists", () => {
    render(
      <TagListField {...defaultProps} initialValues={["Penicillin", "Sulfa"]} />,
    );
    removeButtons("allergies").forEach((btn) => expect(btn).not.toBeDisabled());
  });

  it("removes the targeted tag without affecting the others", () => {
    render(
      <TagListField
        {...defaultProps}
        initialValues={["Penicillin", "Sulfa", "Aspirin"]}
      />,
    );
    // Remove the second tag ("Sulfa").
    fireEvent.click(removeButtons("allergies")[1]);

    const inputs = getInputs("allergies");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("Penicillin");
    expect(inputs[1].value).toBe("Aspirin");
  });

  it("removes the first tag, keeping the rest", () => {
    render(
      <TagListField
        {...defaultProps}
        initialValues={["Penicillin", "Sulfa"]}
      />,
    );
    fireEvent.click(removeButtons("allergies")[0]);

    const inputs = getInputs("allergies");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].value).toBe("Sulfa");
  });

  it("disables remove after reducing to one tag", () => {
    render(
      <TagListField {...defaultProps} initialValues={["Penicillin", "Sulfa"]} />,
    );
    fireEvent.click(removeButtons("allergies")[0]);
    expect(removeButtons("allergies")[0]).toBeDisabled();
  });
});

// ---- duplicate handling ----

describe("TagListField — duplicate tags", () => {
  it("accepts a duplicate value in a separate row (no built-in dedup — server deduplicates)", () => {
    // TagListField itself does not deduplicate; it is the server action's
    // responsibility. This test documents that behaviour so a future
    // in-component dedup change would be a deliberate, noticed breaking change.
    render(
      <TagListField
        {...defaultProps}
        initialValues={["Penicillin"]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /add allergies/i }));
    fireEvent.change(getInputs("allergies")[1], {
      target: { value: "Penicillin" },
    });
    const inputs = getInputs("allergies");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("Penicillin");
    expect(inputs[1].value).toBe("Penicillin");
  });
});

// ---- reuse across different field names ----

describe("TagListField — reusable across field names", () => {
  it("uses the given name prop on every input", () => {
    render(
      <TagListField
        name="medications"
        label="Medications"
        placeholder="e.g. Metformin"
        initialValues={["Metformin", "Insulin"]}
      />,
    );
    const inputs = getInputs("medications");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("Metformin");
  });
});

// ---- error display ----

describe("TagListField — error display", () => {
  it("shows the error message when error prop is provided", () => {
    render(
      <TagListField
        {...defaultProps}
        initialValues={[]}
        error="Please add at least one allergy or enter 'none'."
      />,
    );
    expect(
      screen.getByText(/please add at least one allergy/i),
    ).toBeInTheDocument();
  });

  it("does not render an error element when error is absent", () => {
    render(<TagListField {...defaultProps} initialValues={[]} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
