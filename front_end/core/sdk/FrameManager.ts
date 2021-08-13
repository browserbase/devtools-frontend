// Copyright 2020 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../common/common.js';
import type * as Protocol from '../../generated/protocol.js';

import type {Resource} from './Resource.js';
import type {ResourceTreeFrame} from './ResourceTreeModel.js';
import {Events as ResourceTreeModelEvents, ResourceTreeModel} from './ResourceTreeModel.js';
import type {Target} from './Target.js';
import type {SDKModelObserver} from './TargetManager.js';
import {TargetManager} from './TargetManager.js';

let frameManagerInstance: FrameManager|null = null;

/**
 * The FrameManager is a central storage for all frames. It collects frames from all
 * ResourceTreeModel-instances (one per target), so that frames can be found by id
 * without needing to know their target.
 */
export class FrameManager extends Common.ObjectWrapper.ObjectWrapper<EventTypes> implements
    SDKModelObserver<ResourceTreeModel> {
  private readonly eventListeners: WeakMap<ResourceTreeModel, Common.EventTarget.EventDescriptor[]>;
  private frames: Map<string, {
    frame: ResourceTreeFrame,
    count: number,
  }>;
  private readonly framesForTarget: Map<Protocol.Target.TargetID|'main', Set<Protocol.Page.FrameId>>;
  private topFrame: ResourceTreeFrame|null;
  private creationStackTraceDataForTransferringFrame:
      Map<string, {creationStackTrace: Protocol.Runtime.StackTrace | null, creationStackTraceTarget: Target}>;
  private awaitedFrames: Map<string, {notInTarget?: Target, resolve: (frame: ResourceTreeFrame) => void}[]> = new Map();

  constructor() {
    super();
    this.eventListeners = new WeakMap();
    TargetManager.instance().observeModels(ResourceTreeModel, this);

    // Maps frameIds to frames and a count of how many ResourceTreeModels contain this frame.
    // (OOPIFs are usually first attached to a new target and then detached from their old target,
    // therefore being contained in 2 models for a short period of time.)
    this.frames = new Map();

    // Maps targetIds to a set of frameIds.
    this.framesForTarget = new Map();

    this.topFrame = null;
    this.creationStackTraceDataForTransferringFrame = new Map();
  }

  static instance({forceNew}: {
    forceNew: boolean,
  } = {forceNew: false}): FrameManager {
    if (!frameManagerInstance || forceNew) {
      frameManagerInstance = new FrameManager();
    }
    return frameManagerInstance;
  }

  modelAdded(resourceTreeModel: ResourceTreeModel): void {
    const addListener = resourceTreeModel.addEventListener(ResourceTreeModelEvents.FrameAdded, this.frameAdded, this);
    const detachListener =
        resourceTreeModel.addEventListener(ResourceTreeModelEvents.FrameDetached, this.frameDetached, this);
    const navigatedListener =
        resourceTreeModel.addEventListener(ResourceTreeModelEvents.FrameNavigated, this.frameNavigated, this);
    const resourceAddedListener =
        resourceTreeModel.addEventListener(ResourceTreeModelEvents.ResourceAdded, this.resourceAdded, this);
    this.eventListeners.set(resourceTreeModel, [addListener, detachListener, navigatedListener, resourceAddedListener]);
    this.framesForTarget.set(resourceTreeModel.target().id(), new Set());
  }

  modelRemoved(resourceTreeModel: ResourceTreeModel): void {
    const listeners = this.eventListeners.get(resourceTreeModel);
    if (listeners) {
      Common.EventTarget.removeEventListeners(listeners);
    }

    // Iterate over this model's frames and decrease their count or remove them.
    // (The ResourceTreeModel does not send FrameDetached events when a model
    // is removed.)
    const frameSet = this.framesForTarget.get(resourceTreeModel.target().id());
    if (frameSet) {
      for (const frameId of frameSet) {
        this.decreaseOrRemoveFrame(frameId);
      }
    }
    this.framesForTarget.delete(resourceTreeModel.target().id());
  }

  private frameAdded(event: Common.EventTarget.EventTargetEvent<ResourceTreeFrame>): void {
    const frame = event.data;
    const frameData = this.frames.get(frame.id);
    // If the frame is already in the map, increase its count, otherwise add it to the map.
    if (frameData) {
      // In order to not lose frame creation stack trace information during
      // an OOPIF transfer we need to copy it to the new frame
      frame.setCreationStackTrace(frameData.frame.getCreationStackTraceData());
      this.frames.set(frame.id, {frame, count: frameData.count + 1});
    } else {
      // If the transferring frame's detached event is received before its frame added
      // event in the new target, the persisted frame creation stacktrace is reassigned.
      const traceData = this.creationStackTraceDataForTransferringFrame.get(frame.id);
      if (traceData && traceData.creationStackTrace) {
        frame.setCreationStackTrace(traceData);
      }
      this.frames.set(frame.id, {frame, count: 1});
      this.creationStackTraceDataForTransferringFrame.delete(frame.id);
    }
    this.resetTopFrame();

    // Add the frameId to the the targetId's set of frameIds.
    const frameSet = this.framesForTarget.get(frame.resourceTreeModel().target().id());
    if (frameSet) {
      frameSet.add(frame.id);
    }

    this.dispatchEventToListeners(Events.FrameAddedToTarget, {frame});
    this.resolveAwaitedFrame(frame);
  }

  private frameDetached(event: Common.EventTarget.EventTargetEvent<{frame: ResourceTreeFrame, isSwap: boolean}>): void {
    const {frame, isSwap} = event.data;
    // Decrease the frame's count or remove it entirely from the map.
    this.decreaseOrRemoveFrame(frame.id);

    // If the transferring frame's detached event is received before its frame
    // added event in the new target, we persist the frame creation stacktrace here
    // so that later on the frame added event in the new target it can be reassigned.
    if (isSwap && !this.frames.get(frame.id)) {
      const traceData = frame.getCreationStackTraceData();
      if (traceData.creationStackTrace) {
        this.creationStackTraceDataForTransferringFrame.set(frame.id, traceData);
      }
    }

    // Remove the frameId from the target's set of frameIds.
    const frameSet = this.framesForTarget.get(frame.resourceTreeModel().target().id());
    if (frameSet) {
      frameSet.delete(frame.id);
    }
  }

  private frameNavigated(event: Common.EventTarget.EventTargetEvent): void {
    const frame = (event.data as ResourceTreeFrame);
    this.dispatchEventToListeners(Events.FrameNavigated, {frame});
    if (frame.isTopFrame()) {
      this.dispatchEventToListeners(Events.TopFrameNavigated, {frame});
    }
  }

  private resourceAdded(event: Common.EventTarget.EventTargetEvent<Resource>): void {
    this.dispatchEventToListeners(Events.ResourceAdded, {resource: event.data});
  }

  private decreaseOrRemoveFrame(frameId: Protocol.Page.FrameId): void {
    const frameData = this.frames.get(frameId);
    if (frameData) {
      if (frameData.count === 1) {
        this.frames.delete(frameId);
        this.resetTopFrame();
        this.dispatchEventToListeners(Events.FrameRemoved, {frameId});
      } else {
        frameData.count--;
      }
    }
  }

  /**
   * Looks for the top frame in `frames` and sets `topFrame` accordingly.
   *
   * Important: This method needs to be called everytime `frames` is updated.
   */
  private resetTopFrame(): void {
    const topFrames = this.getAllFrames().filter(frame => frame.isTopFrame());
    this.topFrame = topFrames.length > 0 ? topFrames[0] : null;
  }

  /**
   * Returns the ResourceTreeFrame with a given frameId.
   * When a frame is being detached a new ResourceTreeFrame but with the same
   * frameId is created. Consequently getFrame() will return a different
   * ResourceTreeFrame after detachment. Callers of getFrame() should therefore
   * immediately use the function return value and not store it for later use.
   */
  getFrame(frameId: Protocol.Page.FrameId): ResourceTreeFrame|null {
    const frameData = this.frames.get(frameId);
    if (frameData) {
      return frameData.frame;
    }
    return null;
  }

  getAllFrames(): ResourceTreeFrame[] {
    return Array.from(this.frames.values(), frameData => frameData.frame);
  }

  getTopFrame(): ResourceTreeFrame|null {
    return this.topFrame;
  }

  async getOrWaitForFrame(frameId: Protocol.Page.FrameId, notInTarget?: Target): Promise<ResourceTreeFrame> {
    const frame = this.getFrame(frameId);
    if (frame && (!notInTarget || notInTarget !== frame.resourceTreeModel().target())) {
      return frame;
    }
    return new Promise<ResourceTreeFrame>(resolve => {
      const waiting = this.awaitedFrames.get(frameId);
      if (waiting) {
        waiting.push({notInTarget, resolve});
      } else {
        this.awaitedFrames.set(frameId, [{notInTarget, resolve}]);
      }
    });
  }

  private resolveAwaitedFrame(frame: ResourceTreeFrame): void {
    const waiting = this.awaitedFrames.get(frame.id);
    if (!waiting) {
      return;
    }
    const newWaiting = waiting.filter(({notInTarget, resolve}) => {
      if (!notInTarget || notInTarget !== frame.resourceTreeModel().target()) {
        resolve(frame);
        return false;
      }
      return true;
    });
    if (newWaiting.length > 0) {
      this.awaitedFrames.set(frame.id, newWaiting);
    } else {
      this.awaitedFrames.delete(frame.id);
    }
  }
}

// TODO(crbug.com/1167717): Make this a const enum again
// eslint-disable-next-line rulesdir/const_enum
export enum Events {
  // The FrameAddedToTarget event is sent whenever a frame is added to a target.
  // This means that for OOPIFs it is sent twice: once when it's added to a
  // parent target and a second time when it's added to its own target.
  FrameAddedToTarget = 'FrameAddedToTarget',
  FrameNavigated = 'FrameNavigated',
  // The FrameRemoved event is only sent when a frame has been detached from
  // all targets.
  FrameRemoved = 'FrameRemoved',
  ResourceAdded = 'ResourceAdded',
  TopFrameNavigated = 'TopFrameNavigated',
}

export type EventTypes = {
  [Events.FrameAddedToTarget]: {frame: ResourceTreeFrame},
  [Events.FrameNavigated]: {frame: ResourceTreeFrame},
  [Events.FrameRemoved]: {frameId: Protocol.Page.FrameId},
  [Events.ResourceAdded]: {resource: Resource},
  [Events.TopFrameNavigated]: {frame: ResourceTreeFrame},
};
