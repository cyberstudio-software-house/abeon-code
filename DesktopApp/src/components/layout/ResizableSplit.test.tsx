import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ResizableSplit } from "./ResizableSplit";

describe("ResizableSplit", () => {
  it("renders left and right panels with initial widths", () => {
    render(
      <ResizableSplit
        leftWidth={240}
        minLeft={200}
        maxLeft={400}
        left={<div data-testid="L">left</div>}
        right={<div data-testid="R">right</div>}
        onResize={() => {}}
      />
    );
    expect(screen.getByTestId("L")).toBeInTheDocument();
    expect(screen.getByTestId("R")).toBeInTheDocument();
  });
});
