/**
 * 비공개 Cubism SDK 샘플의 타입 선언.
 * 실제 소스는 `private-assets/` 안에 있어 tsconfig include 밖이므로,
 * 방송 화면이 실제로 쓰는 부분만 여기에 선언한다. 경로는 vite alias `@sdk-sample`로 해석된다.
 */
declare module "@sdk-sample/lappdelegate" {
  export class LAppModel {
    setExpression(expressionId: string): void;
    clearExpression(): void;
    startMotion(group: string, no: number, priority: number, onFinished?: () => void): unknown;
    setManualLipSync(value: number | null): void;
    /** 모델 파일·모션까지 다 읽어 그릴 수 있는 상태인지(CubismUserModel). */
    isInitialized(): boolean;
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
