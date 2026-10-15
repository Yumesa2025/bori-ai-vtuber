/**
 * 이터널리턴 Open API를 흉내 내는 가짜 서버.
 *
 * 실제 키 없이 사전 → 메타 집계 → 전적 조회 흐름을 서버 프로세스째로 검사한다.
 * 응답은 @bori/er 단위 검사의 고정 자료(packages/er/test/fixtures)를 그대로 쓴다. 현재 시즌은 41(API Season21, 게임 표기 시즌 12)이다.
 * - 랭커: 랭커A(uid-a)·랭커B(uid-b), 경기 1001·1002
 * - 전적: PLAYER_NICKNAME(uid-p)만 있다. 다른 닉네임은 404다.
 * 요청 기록에는 경로만 남기고 쿼리(닉네임)·키는 남기지 않는다.
 *
 *   FAKE_ER_PORT=4846 node tools/test/fixtures/fake-er.mjs
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLAYER_NICKNAME = "테스트닉";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/er/test/fixtures");
const fixtureText = name => readFileSync(join(fixtureDir, name), "utf8");
const fixture = name => JSON.parse(fixtureText(name));

const users = {
  "랭커A": "uid-a",
  "랭커B": "uid-b",
  [PLAYER_NICKNAME]: "uid-p",
};

/**
 * @param {{ port: number; host?: string }} options
 */
export async function startFakeEr({ port, host = "127.0.0.1" }) {
  const baseUrl = `http://${host}:${port}`;
  /** 받은 요청 경로와 키 헤더가 있었는지. */
  const calls = [];
  const routes = {
    "/v1/l10n/Korean": { code: 200, message: "Success", data: { l10Path: `${baseUrl}/l10n/Korean.txt` } },
    "/v2/data/Character": fixture("data-character.json"),
    "/v2/data/CharacterMastery": fixture("data-character-mastery.json"),
    "/v2/data/Season": fixture("data-season.json"),
    "/v1/rank/top/41/3": fixture("rank-top.json"),
    "/v1/user/games/uid/uid-a": fixture("user-games-a.json"),
    "/v1/user/games/uid/uid-b": fixture("user-games-b.json"),
    "/v1/user/games/uid/uid-p": fixture("user-games-player.json"),
    "/v1/games/1001": fixture("game-1001.json"),
    "/v1/games/1002": fixture("game-1002.json"),
    "/v2/user/stats/uid/uid-p/41/3": fixture("user-stats-ranked.json"),
    "/v2/user/stats/uid/uid-p/0/2": fixture("user-stats-normal.json"),
  };

  const send = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl);
    calls.push({ path: url.pathname, hasKey: typeof request.headers["x-api-key"] === "string" && request.headers["x-api-key"].length > 0 });
    if (url.pathname === "/l10n/Korean.txt") {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(fixtureText("l10n-korean.txt"));
      return;
    }
    if (url.pathname === "/v1/user/nickname") {
      const nickname = url.searchParams.get("query") ?? "";
      const userId = users[nickname];
      if (!userId) return send(response, 404, { code: 404, message: "Not Found" });
      return send(response, 200, { code: 200, message: "Success", user: { userId, nickname } });
    }
    const body = routes[url.pathname];
    if (!body) return send(response, 404, { code: 404, message: "Not Found" });
    send(response, 200, body);
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolvePromise);
  });

  return {
    calls,
    close: () => new Promise(resolvePromise => server.close(() => resolvePromise())),
  };
}

// 단독 실행
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FAKE_ER_PORT ?? 4846);
  await startFakeEr({ port });
  console.log(`[fake-er] http://127.0.0.1:${port}`);
}
