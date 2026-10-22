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
  advanced: {},
  enabled: true,
  createdAt: "2026-08-21T00:00:00Z",
};

const openai: AiProvider = {
  ...provider,
  id: 8,
  providerType: "openai",
  label: "OpenAI",
  baseUrl: null,
  apiKeyPrefix: "sk-proj",
  defaultModel: "gpt-5",
};

beforeEach(() => {
  api.getAiProviderModels.mockReset();
  api.getAiProviderModels.mockResolvedValue([]);
  api.updateAiProvider.mockReset();
  api.updateAiProvider.mockResolvedValue(provider);
  api.createAiProvider.mockReset();
  api.createAiProvider.mockResolvedValue({ ...openai, id: 9 });
  api.probeAiModels.mockReset();
  api.probeAiModels.mockResolvedValue({ models: [], source: "live" });
  api.getProviderContext.mockReset();
  api.getProviderContext.mockResolvedValue([]);
  // Radix Select calls these, and jsdom has neither.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(cleanup);

async function choose(field: string, option: string) {
  fireEvent.keyDown(screen.getByRole("combobox", { name: field }), {
    key: "Enter",
  });
  fireEvent.keyDown(await screen.findByRole("option", { name: option }), {
    key: "Enter",
  });
}

function openAdvanced() {
  fireEvent.click(screen.getByRole("button", { name: "ai.advanced" }));
}

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

  describe("advanced settings", () => {
    it("are hidden for providers other than OpenAI", () => {
      render(
        <AiProviderSettings providers={[provider]} onChanged={() => {}} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));
      expect(screen.queryByRole("button", { name: "ai.advanced" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "ai.cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "ai.addProvider" }));
      expect(screen.queryByRole("button", { name: "ai.advanced" })).toBeNull();
    });

    it("start closed and open from the toggle", () => {
      render(<AiProviderSettings providers={[openai]} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));

      const toggle = screen.getByRole("button", { name: "ai.advanced" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(
        screen.queryByRole("combobox", { name: "ai.advancedEndpoint" }),
      ).toBeNull();

      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(
        screen.getByRole("combobox", { name: "ai.advancedEndpoint" }),
      ).toBeTruthy();
      expect(screen.getByText("ai.advancedReasoningSummaryHint")).toBeTruthy();
      expect(screen.getByText("ai.advancedTemperatureHint")).toBeTruthy();

      fireEvent.click(toggle);
      expect(
        screen.queryByRole("combobox", { name: "ai.advancedEndpoint" }),
      ).toBeNull();
    });

    it("saves only the settings that are set", async () => {
      render(<AiProviderSettings providers={[openai]} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));
      openAdvanced();

      await choose("ai.advancedReasoningEffort", "ai.advancedHigh");
      fireEvent.change(screen.getByLabelText("ai.advancedMaxOutputTokens"), {
        target: { value: "4096" },
      });
      fireEvent.click(screen.getByRole("button", { name: "ai.save" }));

      await waitFor(() =>
        expect(api.updateAiProvider).toHaveBeenCalledWith(8, {
          label: "OpenAI",
          defaultModel: "gpt-5",
          modelOverrides: {},
          advanced: { reasoningEffort: "high", maxOutputTokens: 4096 },
        }),
      );
    });

    it("clears them on edit when every field is empty", async () => {
      render(
        <AiProviderSettings
          providers={[{ ...openai, advanced: { verbosity: "low" } }]}
          onChanged={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));
      openAdvanced();

      await choose("ai.advancedVerbosity", "ai.advancedDefault");
      fireEvent.click(screen.getByRole("button", { name: "ai.save" }));

      await waitFor(() =>
        expect(api.updateAiProvider).toHaveBeenCalledWith(8, {
          label: "OpenAI",
          defaultModel: "gpt-5",
          modelOverrides: {},
          advanced: null,
        }),
      );
    });

    it("are left out on create when empty and sent when set", async () => {
      render(<AiProviderSettings providers={[]} onChanged={() => {}} />);

      fireEvent.click(screen.getByRole("button", { name: "ai.addProvider" }));
      await choose("ai.providerType", "ai.providerOpenai");
      fireEvent.change(screen.getByLabelText("ai.providerLabel"), {
        target: { value: "Work" },
      });
      fireEvent.click(screen.getByRole("button", { name: "ai.save" }));

      await waitFor(() =>
        expect(api.createAiProvider).toHaveBeenCalledTimes(1),
      );
      expect(api.createAiProvider.mock.calls[0][0]).toEqual({
        providerType: "openai",
        label: "Work",
        baseUrl: null,
        apiKey: null,
        defaultModel: null,
      });
      expect(api.createAiProvider.mock.calls[0][0]).not.toHaveProperty(
        "advanced",
      );

      fireEvent.click(screen.getByRole("button", { name: "ai.addProvider" }));
      await choose("ai.providerType", "ai.providerOpenaiCompatible");
      fireEvent.change(screen.getByLabelText("ai.providerLabel"), {
        target: { value: "Gateway" },
      });
      openAdvanced();
      await choose("ai.advancedEndpoint", "ai.advancedEndpointChat");
      fireEvent.change(screen.getByLabelText("ai.advancedTemperature"), {
        target: { value: "0.7" },
      });
      fireEvent.click(screen.getByRole("button", { name: "ai.save" }));

      await waitFor(() =>
        expect(api.createAiProvider).toHaveBeenCalledTimes(2),
      );
      expect(api.createAiProvider.mock.calls[1][0]).toMatchObject({
        providerType: "openai_compatible",
        label: "Gateway",
        advanced: { endpoint: "chat", temperature: 0.7 },
      });
    });

    it("are filled in from the provider when editing", async () => {
      const advanced = {
        endpoint: "chat",
        reasoningEffort: "xhigh",
        reasoningSummary: "off",
        verbosity: "high",
        maxOutputTokens: 2048,
        temperature: 0.2,
      } as const;
      render(
        <AiProviderSettings
          providers={[{ ...openai, advanced }]}
          onChanged={() => {}}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));
      openAdvanced();

      const shown = (name: string) =>
        screen.getByRole("combobox", { name }).textContent;
      expect(shown("ai.advancedEndpoint")).toBe("ai.advancedEndpointChat");
      expect(shown("ai.advancedReasoningEffort")).toBe("ai.advancedXhigh");
      expect(shown("ai.advancedReasoningSummary")).toBe("ai.advancedOff");
      expect(shown("ai.advancedVerbosity")).toBe("ai.advancedHigh");
      expect(
        (
          screen.getByLabelText(
            "ai.advancedMaxOutputTokens",
          ) as HTMLInputElement
        ).value,
      ).toBe("2048");
      expect(
        (screen.getByLabelText("ai.advancedTemperature") as HTMLInputElement)
          .value,
      ).toBe("0.2");

      fireEvent.click(screen.getByRole("button", { name: "ai.save" }));
      await waitFor(() =>
        expect(api.updateAiProvider).toHaveBeenCalledWith(
          8,
          expect.objectContaining({ advanced }),
        ),
      );
    });

    it("block saving while the temperature is out of range", async () => {
      render(<AiProviderSettings providers={[openai]} onChanged={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: "ai.editProvider" }));
      openAdvanced();

      const temperature = screen.getByLabelText("ai.advancedTemperature");
      const save = screen.getByRole("button", { name: "ai.save" });
      fireEvent.change(temperature, { target: { value: "2.5" } });

      expect(screen.getByText("ai.advancedTemperatureInvalid")).toBeTruthy();
      expect((save as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(save);
      expect(api.updateAiProvider).not.toHaveBeenCalled();

      fireEvent.change(temperature, { target: { value: "1.5" } });
      expect(screen.queryByText("ai.advancedTemperatureInvalid")).toBeNull();
      fireEvent.click(save);
      await waitFor(() =>
        expect(api.updateAiProvider).toHaveBeenCalledWith(
          8,
          expect.objectContaining({ advanced: { temperature: 1.5 } }),
        ),
      );
    });
  });
});
