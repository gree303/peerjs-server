import EventEmitter from "events";
import { IncomingMessage } from "http";
import url from "url";
import WebSocketLib from "ws";
import { IConfig } from "../../config";
import { Errors, MessageType } from "../../enums";
import { Client, IClient } from "../../models/client";
import { IRealm } from "../../models/realm";
import type WebSocket from "ws";

export interface IWebSocketServer extends EventEmitter {
  readonly path: string;
}

interface IAuthParams {
  id?: string;
  token?: string;
  key?: string;
}

type CustomConfig = Pick<IConfig, 'path' | 'key' | 'concurrent_limit' | 'createWebSocketServer'>;

const WS_PATH = 'peerjs';

export class WebSocketServer extends EventEmitter implements IWebSocketServer {

  public readonly path: string;
  private readonly realm: IRealm;
  private readonly config: CustomConfig;
  public readonly socketServer: WebSocketLib.Server;

  constructor({ server, realm, config }: { server: any; realm: IRealm; config: CustomConfig; }) {
    super();

    this.setMaxListeners(0);

    this.realm = realm;
    this.config = config;

    const path = this.config.path;
    this.path = `${path}${path.endsWith('/') ? "" : "/"}${WS_PATH}`;

    const options: WebSocketLib.ServerOptions = {
      path: this.path,
      server,
    };

    this.socketServer = (
        config.createWebSocketServer ?
            config.createWebSocketServer(options) :
            new WebSocketLib.Server(options)
    );

    this.socketServer.on("connection", (socket, req) => this._onSocketConnection(socket, req));
    this.socketServer.on("error", (error: Error) => this._onSocketError(error));
  }

  private _onSocketConnection(socket: WebSocket, req: IncomingMessage): void {
    // An unhandled socket error might crash the server. Handle it first.
    socket.on("error", error => this._onSocketError(error))

    const { query = {} } = url.parse(req.url ?? '', true);

    const { id, token, key }: IAuthParams = query;

    if (!id || !token || !key) {
      return this._sendErrorAndClose(socket, Errors.INVALID_WS_PARAMETERS);
    }

    if (key !== this.config.key) {
      return this._sendErrorAndClose(socket, Errors.INVALID_KEY);
    }

    const client = this.realm.getClientById(id);

    if (client) {
      if (token !== client.getToken()) {
        // ID-taken, invalid token
        socket.send(JSON.stringify({
          type: MessageType.ID_TAKEN,
          payload: { msg: "ID is taken" }
        }));

        return socket.close();
      }

      return this._configureWS(socket, client);
    }

    this._registerClient({ socket, id, token });
  }

  private _onSocketError(error: Error): void {
    // handle error
    this.emit("error", error);
  }

  private _registerClient({ socket, id, token }:
    {
      socket: WebSocket;
      id: string;
      token: string;
    }): void {
    // Check concurrent limit
    const clientsCount = this.realm.getClientsIds().length;

    if (clientsCount >= this.config.concurrent_limit) {
      return this._sendErrorAndClose(socket, Errors.CONNECTION_LIMIT_EXCEED);
    }

    const newClient: IClient = new Client({ id, token });
    this.realm.setClient(newClient, id);
    socket.send(JSON.stringify({ type: MessageType.OPEN }));

    this._configureWS(socket, newClient);
  }

  private _configureWS(socket: WebSocket, client: IClient): void {
    client.setSocket(socket);

    // Cleanup after a socket closes.
    socket.on("close", () => {
      if (client.getSocket() === socket) {
        this.realm.removeClientById(client.getId());
        this.emit("close", client);
      }
    });

    // Handle messages from peers.
    socket.on("message", (data: WebSocketLib.Data) => {
      try {
        const message = JSON.parse(data as string);

        message.src = client.getId();

        this.emit("message", client, message);
      } catch (e) {
        this.emit("error", e);
      }
    });

    this.emit("connection", client);
  }

  private _sendErrorAndClose(socket: WebSocket, msg: Errors): void {
    socket.send(
      JSON.stringify({
        type: MessageType.ERROR,
        payload: { msg }
      })
    );

    socket.close();
  }
}
