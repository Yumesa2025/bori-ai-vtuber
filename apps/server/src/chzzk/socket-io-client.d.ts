/**
 * socket.io-client 2.0.3 최소 타입 선언.
 * 치지직 세션은 2.0.3까지만 지원하는데(공식 문서) 이 버전은 타입을 함께 주지 않는다.
 * 타입 패키지를 새로 들이지 않고 세션 모듈이 쓰는 부분만 적는다.
 */
declare module "socket.io-client" {
  export type ConnectOptions = Record<string, unknown>;

  export interface Socket {
    on(event: string, listener: (...args: unknown[]) => void): Socket;
    /** 이벤트 처리기를 모두 떼어 낸다(component-emitter). */
    off(): Socket;
    close(): Socket;
  }

  export function connect(url: string, options?: ConnectOptions): Socket;
}
