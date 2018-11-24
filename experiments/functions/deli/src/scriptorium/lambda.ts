import * as coreUtils from "@prague/client-api";
import * as core from "@prague/routerlicious/dist/core";
import * as utils from "@prague/routerlicious/dist/utils";
import * as assert from "assert";
import { EventEmitter } from "events";
import * as winston from "winston";
import { IContext, IPartitionLambda } from "../kafka-service/lambdas";

/**
 * A batch takes in a key type and then a value type that is accumulated against the key. The key type must be
 * able to be stringified so that we can properly batch work.
 */
export class Batch<K, T> {
    private pendingWork = new Map<string, T[]>();

    public add(id: K, work: T) {
        const encoded = JSON.stringify(id);

        if (!this.pendingWork.has(encoded)) {
            this.pendingWork.set(encoded, []);
        }

        this.pendingWork.get(encoded).push(work);
    }

    /**
     * Clears all the pending work
     */
    public clear() {
        this.pendingWork.clear();
    }

    /**
     * Runs the given async mapping function on the batch
     */
    public async map(fn: (id: K, work: T[]) => Promise<void>): Promise<void> {
        const processedP = new Array<Promise<void>>();
        for (const [key, value] of this.pendingWork) {
            const mapP = fn(JSON.parse(key) as K, value);
            processedP.push(mapP);
        }

        await Promise.all(processedP);
    }
}

/**
 * Wrapper class to combine a batch with the log offset that maps to it
 */
class OffsetBatch<K, T> {
    public offset: number;
    public batch = new Batch<K, T>();

    public clear() {
        this.offset = undefined;
        this.batch.clear();
    }

    /**
     * Returns whether or not this batch is empty
     */
    public isEmpty() {
        return this.offset === undefined;
    }
}

/**
 * The BatchManager is used to manage async work triggered by messages to a pub/sub log
 */
export class BatchManager<K, T> extends EventEmitter {
    public static MinRangeValue = Number.NEGATIVE_INFINITY;

    public range = new coreUtils.Range(BatchManager.MinRangeValue, BatchManager.MinRangeValue);

    // The manager maintains a pending batch of operations as well as a current batch. The current batch is the
    // one that is in the process of being sent. The pending batch is the next batch that will be sent.
    private pending = new OffsetBatch<K, T>();
    private current = new OffsetBatch<K, T>();

    private closed = false;

    constructor(private sendFn: (batch: Batch<K, T>) => Promise<void>) {
        super();
    }

    /**
     * Adds a new value to the batch and updates the log offset
     */
    public add(id: K, value: T, offset: number) {
        // Track whether we are transitioning from empty to not-empty. In that case we adjust
        // the tail of the range to be one less than the offset. This is the lowest offset we could
        // checkpoint at since it does not include the new batch of work.
        const wasEmpty = this.range.empty;
        this.range.head = offset;
        if (wasEmpty) {
            this.range.tail = offset - 1;
        }

        this.pending.batch.add(id, value);
        this.pending.offset = offset;
        this.requestSend();
    }

    public close() {
        this.closed = true;
    }

    /**
     * Requests a send of the current batch
     */
    private requestSend() {
        // If the current batch is not empty then there is a send in flight. Otherwise begin a new send.
        if (!this.current.isEmpty()) {
            return;
        } else {
            this.sendPending();
        }
    }

    private sendPending() {
        // Exit early if closed
        if (this.closed) {
            return;
        }

        // If pending is empty return early - there is no work to do
        if (this.pending.isEmpty()) {
            return;
        }

        // Swap current and pending
        const temp = this.current;
        this.current = this.pending;
        this.pending = temp;

        // Serialize the current batch to Mongo
        const processedP = this.sendFn(this.current.batch);

        // Once processed update the log offset and then begin the next batch
        const doneP = processedP.then(
            () => {
                // Processing was successful. Update the tail of the offset...
                this.range.tail = this.current.offset;
                this.emit("workComplete", this.current.offset);

                // And then clear the processed batch and start on pending.
                this.current.clear();
                this.sendPending();
            });

        doneP.catch((error) => {
            // Notify of the error
            this.emit("error", error);
        });
    }
}

export class WorkManager extends EventEmitter {
    private work = new Array<BatchManager<any, any>>();

    // Start out at negative infinity. This represents an unknown offset and matches how the range is stored. We
    // won't fire an offset event until this changes
    private lastOffset = BatchManager.MinRangeValue;

    constructor() {
        super();
    }

    public createBatchedWork<K, T>(processFn: (batch: Batch<K, T>) => Promise<void>): BatchManager<K, T> {
        const batchedWork = new BatchManager<K, T>(processFn);

        // Listen for error events as well as when a batch is complete - and the offset may have changed
        batchedWork.on("error", (error) => {
            this.emit("error", error);
        });

        batchedWork.on("workComplete", () => {
            this.updateOffset();
        });

        this.work.push(batchedWork);
        return batchedWork;
    }

    public close() {
        for (const work of this.work) {
            work.close();
        }
    }

    private updateOffset() {
        let maxHead = this.lastOffset;
        let range = new coreUtils.Range();

        for (const work of this.work) {
            maxHead = Math.max(maxHead, work.range.head);
            range = coreUtils.Range.union(range, work.range);
        }

        // If all the offsets are empty we take the max of the heads (which will be the largest offset seen). Otherwise
        // it is the smallest tail
        const offset = range.empty ? maxHead : range.tail;
        assert.ok(offset >= this.lastOffset);
        if (offset !== this.lastOffset) {
            this.lastOffset = offset;
            this.emit("offsetChanged", offset);
        }
    }
}

interface IMongoTarget {
    documentId: string;
    tenantId: string;
}

export class ScriptoriumLambda implements IPartitionLambda {
    // We maintain three batches of work - one for MongoDB and the other two for Socket.IO.
    // One socket.IO group is for sequenced ops and the other for nack'ed messages.
    // By splitting the two we can update each independently and on their own cadence
    private mongoManager: BatchManager<IMongoTarget, core.ISequencedOperationMessage>;
    private idleManager: BatchManager<string, void>;

    private workManager = new WorkManager();

    constructor(
        private opCollection: core.ICollection<any>,
        private contentCollection: core.ICollection<any>,
        protected context: IContext) {

        // Listen for work errors
        this.workManager.on("error", (error) => {
            this.batchError(error);
        });

        // Listen for offset changes and checkpoint accordingly
        this.workManager.on("offsetChanged", (offset: number) => {
            winston.verbose(`Checkpointing at ${offset}`);
            context.checkpoint(offset);
        });

        // Create all the batched workers
        this.mongoManager = this.workManager.createBatchedWork((batch) => this.processMongoBatch(batch));
        this.idleManager = this.workManager.createBatchedWork(async (batch) => { return; });
    }

    public handler(message: utils.IMessage): void {
        const messageContent = message.value.toString();

        const parsedMessage = utils.safelyParseJSON(messageContent);
        if (parsedMessage === undefined) {
            winston.error(`Invalid JSON input: ${messageContent}`);
            return;
        }

        const baseMessage = parsedMessage as core.IMessage;
        if (baseMessage.type === core.SequencedOperationType) {
            const value = baseMessage as core.ISequencedOperationMessage;

            // Remove traces and serialize content before writing to mongo.
            value.operation.traces = [];

            // Back-Compat: Older message does not have metadata field and not serialized.
            if (!value.operation.metadata) {
                value.operation.contents = JSON.stringify(value.operation.contents);
            }

            // Batch send to MongoDB
            this.mongoManager.add(
                {
                    documentId: value.documentId,
                    tenantId: value.tenantId,
                },
                value,
                message.offset);
        } else {
            // Treat all other messages as an idle batch of work for simplicity
            this.idleManager.add(null, null, message.offset);
        }
    }

    public close() {
        this.workManager.close();
    }

    /**
     * BatchManager callback invoked once a new batch is ready to be processed
     */
    private async processMongoBatch(batch: Batch<IMongoTarget, core.ISequencedOperationMessage>): Promise<void> {
        // Serialize the current batch to Mongo
        await batch.map(async (id, work) => {
            // tslint:disable-next-line:max-line-length
            winston.verbose(`Inserting to mongodb ${id.documentId}/${id.tenantId}@${work[0].operation.sequenceNumber}:${work.length}`);
            return this.processMongoCore(work);
        });
    }

    private async processMongoCore(messages: core.ISequencedOperationMessage[]): Promise<void> {
        const insertP = this.insertOp(messages);
        const updateP = this.updateSequenceNumber(messages);
        await Promise.all([insertP, updateP]);
    }

    private async insertOp(messages: core.ISequencedOperationMessage[]) {
        return this.opCollection.insertMany(messages, false)
            .catch((error) => {
                // Duplicate key errors are ignored since a replay may cause us to insert twice into Mongo.
                // All other errors result in a rejected promise.
                if (error.name !== "MongoError" || error.code !== 11000) {
                    // Needs to be a full rejection here
                    return Promise.reject(error);
                }
            });
    }

    private async updateSequenceNumber(messages: core.ISequencedOperationMessage[]) {
        // TODO (mdaumi): Temporary to back compat with local orderer.
        if (this.contentCollection === undefined) {
            return Promise.resolve();
        } else {
            const updateP = [];
            for (const message of messages) {
                // Back-Compat: Temporary workaround to handle old clients.
                if (message.operation.metadata && message.operation.metadata.split) {
                    updateP.push(this.contentCollection.update(
                        {
                            "clientId": message.operation.clientId,
                            "documentId": message.documentId,
                            "op.clientSequenceNumber": message.operation.clientSequenceNumber,
                            "tenantId": message.tenantId,
                        },
                        {sequenceNumber: message.operation.sequenceNumber},
                        null).catch((error) => {
                            // Same reason as insertOp.
                            if (error.name !== "MongoError" || error.code !== 11000) {
                                return Promise.reject(error);
                            }
                        }));
                }
            }
            if (updateP.length > 0) {
                await Promise.all(updateP);
            }
        }
    }

    /**
     * BatchManager callback invoked after an error
     */
    private batchError(error: string) {
        winston.error(error);
        this.context.error(error, true);
    }
}
