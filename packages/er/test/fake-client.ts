/**
 * 경로별로 정해 둔 응답을 돌려주는 가짜 ErClient. 없는 경로는 404 ErApiError다.
 */
import { readFileSync } from "node:fs";
import { ErApiError, type ErClient } from "../src/client.js";

export function fixture<T = unknown>(name: string): T {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return (name.endsWith(".json") ? JSON.parse(text) : text) as T;
}

export type FakeClient = ErClient & { calls: string[] };

export function fakeClient(routes: Record<string, unknown>): FakeClient {
  const calls: string[] = [];
  return {
    calls,
    async get<T>(path: string): Promise<T> {
      calls.push(path);
      if (!(path in routes)) throw new ErApiError(404, 404, `없는 경로: ${path.split("?")[0]}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value as T;
    },
  };
}

/** 사전 응답 묶음. 메타·전적 검사도 같은 사전을 쓴다. */
export const L10N_URL = "https://cdn.example.com/l10n/Korean.txt";

export function dictionaryRoutes(l10nKey: "l10Path" | "l10nPath" = "l10Path"): Record<string, unknown> {
  return {
    "/v1/l10n/Korean": { code: 200, message: "Success", data: { [l10nKey]: L10N_URL } },
    [L10N_URL]: fixture("l10n-korean.txt"),
    "/v2/data/Character": fixture("data-character.json"),
    "/v2/data/CharacterMastery": fixture("data-character-mastery.json"),
    "/v2/data/Season": fixture("data-season.json"),
  };
}
