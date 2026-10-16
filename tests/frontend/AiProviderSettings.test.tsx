import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AiProvider } from "../../src/frontend/ai-api";

const api = vi.hoisted(() => ({
  createAiProvider: vi.fn(),
  deleteAiProvider: vi.fn(),
  getAiProviderModels: vi.fn(),
  getProviderContext: vi.fn(),
  probeAiModels: vi.fn(),
  CONTEXT_SOURCE_KEYS: {
    override: "ai.contextSourceOverride",
    provider: "ai.contextSourceProvider",
    guess: "ai.contextSourceGuess",
    default: "ai.contextSourceDefault",
  },
  updateAiProvider: vi.fn(),
}));

vi.mock("../../src/frontend/ai-api", () => api);
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AiProviderSettings } from "../../src/frontend/AiProviderSettings";

const provider: AiProvider = {
  id: 7,
  providerType: "ollama",
  label: "Local Ollama",
  baseUrl: "http://localhost:11434",
  apiKeyPrefix: null,
  defaultModel: "llama3.1",
  modelOverrides: {},
  enabled: true,
  createdAt: "2026-08-21T00:00:00Z",
};

beforeEach(() => {
  api.getAiProviderModels.mockReset();
  api.getAiProviderModels.mockResolvedValue([]);
  api.updateAiProvider.mockReset();
  api.updateAiProvider.mockResolvedValue(provider);
  api.getProviderContext.mockReset();
  api.getProviderContext.mockResolvedValue([]);
});

afterEach(cleanup);

describe("AiProviderSettings", () => {
  it("edits an existing provider name and configured model", async () => {
    const onChanged = vi.fn();
    render(<AiProviderSettings providers={[provider]} onChanged={onChanged} />);

    expect(screen.getByText(/llama3\.1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));

    const label = screen.getByLabelText("ai.providerLabel");
    const model = screen.getByLabelText("ai.defaultModel");
    fireEvent.change(label, { target: { value: "Production Ollama" } });
    fireEvent.change(model, { target: { value: "qwen3:32b" } });
    fireEvent.click(screen.getByRole("button", { name: "ai.save" }));

    await waitFor(() => {
      expect(api.updateAiProvider).toHaveBeenCalledWith(7, {
        label: "Production Ollama",
        defaultModel: "qwen3:32b",
        modelOverrides: {},
      });
    });
    expect(onChanged).toHaveBeenCalledWith(7);
  });

  it("loads the saved provider model list when editing starts", async () => {
    api.getAiProviderModels.mockResolvedValue(["llama3.1", "qwen3:32b"]);
    render(<AiProviderSettings providers={[provider]} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));

    await waitFor(() => {
      expect(api.getAiProviderModels).toHaveBeenCalledWith(7);
    });
    expect(
      screen.getByRole("combobox", { name: "ai.defaultModel" }),
    ).toBeTruthy();
  });

  it("shows the provider error when refreshing models fails", async () => {
    api.getAiProviderModels.mockRejectedValue(
      new Error("Add llm.internal to the AI endpoint allowlist"),
    );
    render(<AiProviderSettings providers={[provider]} onChanged={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));

    expect(
      await screen.findByText("Add llm.internal to the AI endpoint allowlist"),
    ).toBeTruthy();
  });

  it("shows each model's window and saves an override per model", async () => {
    api.getProviderContext.mockResolvedValue([
      {
        model: "llama3.1",
        contextWindow: 131072,
        source: "provider",
        reservedOutput: 8192,
        reportedWindow: 131072,
        override: null,
      },
      {
        model: "qwen3:32b",
        contextWindow: 128000,
        source: "guess",
        reservedOutput: 8192,
        reportedWindow: null,
        override: null,
      },
    ]);
    render(
      <AiProviderSettings
        providers={[
          {
            ...provider,
            modelOverrides: { "qwen3:32b": { contextWindow: 1 } },
          },
        ]}
        onChanged={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));

    await waitFor(() =>
      expect(api.getProviderContext).toHaveBeenCalledWith(7, {
        models: ["llama3.1"],
        refresh: false,
      }),
    );
    const fields = await screen.findAllByLabelText("ai.contextOverride");
    expect(fields).toHaveLength(2);
    expect(screen.getAllByText("ai.contextWindowValue")).toHaveLength(2);
    expect((fields[0] as HTMLInputElement).placeholder).toBe("131072");

    fireEvent.change(fields[0], { target: { value: "65536" } });
    fireEvent.change(fields[1], { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "ai.save" }));

    await waitFor(() =>
      expect(api.updateAiProvider).toHaveBeenCalledWith(7, {
        label: "Local Ollama",
        defaultModel: "llama3.1",
        modelOverrides: { "llama3.1": { contextWindow: 65536 } },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /ai\.contextRefresh/ }),
    );
    await waitFor(() =>
      expect(api.getProviderContext).toHaveBeenLastCalledWith(7, {
        models: ["llama3.1"],
        refresh: true,
      }),
    );
  });
});
