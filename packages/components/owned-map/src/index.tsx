/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

// tslint:disable:no-console
import {
  PrimedComponent,
  PrimedComponentFactory,
  SimpleModuleInstantiationFactory,
} from "@prague/aqueduct";
import {
  IComponentHandle,
  IComponentHTMLOptions,
  IComponentHTMLVisual,
} from "@prague/component-core-interfaces";
import { Counter, CounterValueType } from "@prague/map";
import * as React from "react";
import * as ReactDOM from "react-dom";
import { OwnedSharedMap } from "./ownedMap";

export class OwnedMap extends PrimedComponent implements IComponentHTMLVisual {

  public static getFactory() { return OwnedMap.factory; }

  public get IComponentHTMLVisual() { return this; }

  private static readonly factory = new PrimedComponentFactory(
    OwnedMap,
    [
      OwnedSharedMap.getFactory(),
    ],
  );

  public ownedMap: OwnedSharedMap;
  public counter: Counter;

  // #region IComponentHTMLVisual
  public render(elm: HTMLElement, options?: IComponentHTMLOptions): void {
    const render = () => this.doRender(elm);
    this.root.on("op", () => {
      render();
    });

    this.ownedMap.on("op", () => {
      render();
    });

    this.doRender(elm);
  }
  // #endregion IComponentHTMLVisual

  /**
   *  The component has been loaded. Render the component into the provided div
   */
  protected async componentInitializingFromExisting() {
    this.counter = await this.root.wait<Counter>("clicks");
    const ownedMapHandle = await this.root.wait<IComponentHandle>("ownedMap");
    this.ownedMap = await ownedMapHandle.get<OwnedSharedMap>();
  }

  /**
   * Create the component's schema and perform other initialization tasks
   * (only called when document is initially created).
   */
  protected async componentInitializingFirstTime() {
    this.root.set("clicks", 0, CounterValueType.Name);
    this.counter = await this.root.wait<Counter>("clicks");
    this.root.set("ownedMap", OwnedSharedMap.create(this.runtime).handle);
    const ownedMapHandle = await this.root.wait<IComponentHandle>("ownedMap");
    this.ownedMap = await ownedMapHandle.get<OwnedSharedMap>();
    this.ownedMap.set("title", "Default Title");
  }

  private doRender(host: HTMLElement) {

    let title = "Not Defined Yet!";
    let amOwner = false;
    let change = (e) => alert("Map Not defined");

    if (this.ownedMap) {
      amOwner = this.ownedMap.isOwner(this.runtime.clientId);
      change = (e: Event) => this.ownedMap.set("title", (e.target as HTMLInputElement).value);
      title = this.ownedMap.get<string>("title");

      if (amOwner) {
        console.log("I am owner");
      } else {
        console.log(" Non Owner");
      }

    }

    ReactDOM.render(
      <div>
        {this.ownedMap ?
          <div>
            <p>Owned Map exists</p>
            {amOwner ? <p> I am owner </p> : <p>Non Owner</p>}
          </div>
          : <p>No Owned Map</p>}
        <p>{title}</p>
        <input type={"text"} onChange={change} />
        <br />
        <br />

        <span>{this.counter.value}</span>
        <button onClick={() => this.counter.increment(1)}>+</button>
      </div>,
      host,
    );
  }
}

export const fluidExport = new SimpleModuleInstantiationFactory(
  "@chaincode/owned-map",
  new Map([
    ["@chaincode/owned-map", Promise.resolve(OwnedMap.getFactory())],
  ]),
);
