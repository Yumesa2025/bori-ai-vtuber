/**
 * 비공개 Cubism SDK 샘플의 타입 선언.
 * 실제 소스는 `private-assets/` 안에 있어 tsconfig include 밖이므로,
 * 대화 화면이 실제로 쓰는 부분만 여기에 선언한다. 경로는 vite alias `@sdk-sample`로 해석된다.
 * 방송 화면(`apps/broadcast/src/sdk-sample.d.ts`)과 같은 선언이다.
 */
declare module "@sdk-sample/lappdelegate" {
  export class LAppModel {
    setExpression(expressionId: string): void;
    clearExpression(): void;
    startMotion(group: string, no: number, priority: number, onFinished?: () => void): unknown;
    setManualLipSync(value: number | null): void;
  }

  export class LAppDelegate {
    static getInstance(): LAppDelegate;
    static releaseInstance(): void;
    initialize(): boolean;
    run(): void;
    getLoadedModel(index?: number): LAppModel | null;
    lookAt(x: number, y: number): void;
  }
}
