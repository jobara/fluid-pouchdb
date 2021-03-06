/* eslint-env node */
/*

    Provide a CouchDB-like API using `PouchDB` and `express-pouchdb`.  This in only useful in association with an
    existing `fluid.express` instance.  See the documentation for details:

    https://github.com/fluid-project/fluid-pouchdb/blob/master/docs/pouch-express.md

 */
"use strict";

/*

    TODO:  Work through the express-pouchdb setup and code with Antranig, as we see many warnings like:

    `Warning: a promise was created in a handler but was not returned from it`

    The workaround for now is to set the `BLUEBIRD_WARNINGS` environment variable to `0`.

 */
process.env.BLUEBIRD_WARNINGS = 0;

var fluid = require("infusion");
fluid.registerNamespace("fluid.pouch.express");

var os             = require("os");
var fs             = require("graceful-fs");
var memdown        = require("memdown");

var expressPouchdb = require("@the-t-in-rtf/express-pouchdb");

var PouchDB        = require("pouchdb");

var path = fluid.require("path", require, "path");

// The cleanup cycle used by express-pouchdb leaves a shedload of listeners around.  To avoid these, we disable the
// event listener warnings, but only for PouchDB itself.
PouchDB.setMaxListeners(250);

/**
 * A static function to expand all variations on the definitions used in `options.databases`:
 *
 *   1. dbName: { data: "singlePath"} // One single file to be loaded, long notation.  No custom options.
 *   2. dbName: { data: ["path1", "path2"] } // Multiple files to be loaded, long notation, no custom options.
 *   3. dbName: { data: ["path1", "path2"], dbOptions: { db: memdown } } // Long notation, including additional custom database options.
 *   4. dbName: { dbOptions: { db: memdown} } // Long notation, no data, but with custom database options.
 *   5. dbName: {} // No data, no custom options.
 *
 * @param {Object} dbDef - The definition of a single database in any of the above formats.
 * @return {Object} - An expanded record in Object form.
 *
 */
fluid.pouch.express.expandDbDef = function (dbDef) {
    var expandedDef = {};
    if (typeof dbDef === "object" && dbDef !== null) {
        expandedDef = fluid.copy(dbDef);
        if (expandedDef.data) {
            expandedDef.data = fluid.makeArray(expandedDef.data);
        }
    }

    return expandedDef;
};


/**
 *
 * Initialize our instance of express-pouchdb.
 *
 * @param {Object} that - The component itself.
 * @return {Object} - The expressPouchDB middleware.
 *
 */
fluid.pouch.express.initExpressPouchdb = function (that) {
    fluid.log("express pouchdb instance '", that.id, "' initalizing...");

    if (!that.options.baseDir) {
        fluid.fail("You must specify a basedir option...");
    }
    // Create our base directory if it doesn't already exist.
    else if (!fs.existsSync(that.options.baseDir)) {
        fluid.log("Creating directory '", that.options.baseDir, "' for express pouchdb instance '", that.id, "'...");
        fs.mkdirSync(that.options.baseDir);
        that.baseDirBelongsToUs = true;
    }

    that.PouchDB = PouchDB.defaults(fluid.copy(that.options.dbOptions));
    that.expressPouchdb = expressPouchdb(that.PouchDB, fluid.copy(that.options.expressPouchConfig));

    return that.expressPouchdb;
};

/**
 *
 * Initialize all of the configured databases in `that.options.database`.
 *
 * @param {Object} that - The component itself.
 * @return {Promise} - A `fluid.promise.sequence` that will be resolved when all databases are initialized.
 *
 */
fluid.pouch.express.initDbs = function (that) {
    // We create our components programatically because we need:
    //
    //   1. To be notified when all databases are ready for use.  We do this with a `fluid.promise.sequence`.
    //   2. A way to clean up each database later on.  We do this by retaining a list of database instances.
    //   3. A way to know when all of them have been destroyed.  We do this with another `sequence` in our cleanup invoker (see below).
    //
    // I can think of ways to accomplish #2 with dynamic components, but not 1 and 3.
    // TODO: Review with Antranig.

    var promises = [];
    fluid.each(that.options.databases, function (dbOptions, dbKey) {
        promises.push(fluid.pouch.express.initDb(that, dbKey, dbOptions));
    });

    var sequence = fluid.promise.sequence(promises);
    sequence.then(function () {
        that.events.onStarted.fire();
    });

    return sequence;
};

/**
 *
 * Initialize a single database instance.
 *
 * @param {Object} that - The component itself
 * @param {String} dbKey - The database name.
 * @param {Object} dbDef - Our convention for representing multiple databases.  See the docs for examples.
 * @return {Promise} A promise that will be resolved with the database is initialized.
 */
fluid.pouch.express.initDb = function (that, dbKey, dbDef) {
    var expandedDef = fluid.pouch.express.expandDbDef(dbDef);
    var dataLoadedPromise = fluid.promise();
    var dbOptions = expandedDef.dbOptions ? fluid.merge(that.options.dbOptions, expandedDef.dbOptions) : fluid.copy(that.options.dbOptions);
    dbOptions.name = dbKey;
    var dbComponentOptions = {
        type: "fluid.component",
        gradeNames: that.options.pouchGradeNames,
        dbOptions: dbOptions,
        baseDir: that.options.baseDir,
        listeners: {
            "onDataLoaded.resolvePromise": {
                func: dataLoadedPromise.resolve
            }
        }
    };
    if (expandedDef.data) {
        dbComponentOptions.dbPaths = expandedDef.data;
    }

    var dbComponent = fluid.construct("fluid_pouch_" + that.id + "_" + dbKey, dbComponentOptions);
    that.databaseInstances[dbKey] = dbComponent;

    var viewCleanupPromise = fluid.promise();

    dataLoadedPromise.then(function () {
        dbComponent.viewCleanup().then(viewCleanupPromise.resolve, viewCleanupPromise.reject);
    }, viewCleanupPromise.reject);

    return viewCleanupPromise;
};

/**
 *
 * Pass along any requests to our instance of express-pouchdb.
 *
 * @param {Object} that - The component itself.
 * @param {Object} req - The Express request object.
 * @param {Object} res - The Express response object.
 * @param {Function} next - The next piece of middleware in the chain.
 *
 */
fluid.pouch.express.middleware = function (that, req, res, next) {
    // fluid.log("express pouchdb instance '", that.id, "' responding...")
    that.expressPouchdb(req, res, next);
};

fluid.pouch.express.destroyDbs = function (that) {
    fluid.each(that.databaseInstances, function (oneDb) {
        oneDb.destroy();
    });
};

/**
 *
 * Clean up any instance of `fluid.pouchdb` that we're aware of.  Then, to get rid of databases created by
 * express-pouchdb, complete remove all data in `options.baseDir`.
 *
 * @param {Object} that - The component itself.
 * @return {Promise} - A promise that will be resolved when cleanup is complete.
 *
 */
fluid.pouch.express.cleanup = function (that) {
    var tmpPouchDB = PouchDB.defaults({ db: memdown});
    var togo = fluid.promise();
    togo.then(that.events.onCleanupComplete.fire, that.events.onError.fire);
    togo.then(that.destroyDbs, that.destroyDbs);

    that.expressPouchdb.setPouchDB(tmpPouchDB).then(function () {
        var cleanupPromises = [];

        fluid.each(that.databaseInstances, function (databaseInstance) {
            // Ensure that one cleanup at a time takes place.
            cleanupPromises.push(function () { return databaseInstance.destroyPouch(); });
        });

        var logCleanupPromise = fluid.pouchdb.timelyRimraf(that.options.expressPouchLogPath, {}, that.options.rimrafTimeout);
        cleanupPromises.push(logCleanupPromise);

        var cleanupSequence = fluid.promise.sequence(cleanupPromises);
        cleanupSequence.then(function () {
            if (that.baseDirBelongsToUs) {
                var newPath = that.options.baseDir + "-OLD-" + Date.now();

                try {
                    fs.renameSync(that.options.baseDir, newPath);

                    var removePromise = fluid.pouchdb.timelyRimraf(newPath, {}, that.options.rimrafTimeout);
                    removePromise.then(function () {
                        fluid.log("Removed temporary directory '", that.options.baseDir, "'...");
                        togo.resolve();
                    }, function (error) {
                        fluid.log("ERROR removing temporary directory:", error);
                        togo.resolve();
                    });
                }
                catch (error) {
                    fluid.log("ERROR renaming directory:", error);
                    togo.resolve();
                }
            }
            else {
                togo.resolve();
            }
        }, function (error) {
            fluid.log("Cleanup error:", error);
            togo.resolve();
        });
    });

    return togo;
};

fluid.pouch.express.generateUniqueLogPath = function (that) {
    return path.resolve(that.options.baseDir, "express-pouchdb-log-" + that.id + ".txt");
};

fluid.defaults("fluid.pouch.express.base", {
    gradeNames: ["fluid.component", "fluid.express.middleware"],
    method: "use", // We have to support all HTTP methods, as does our underlying router.
    path: "/",
    namespace: "pouch-express", // Namespace to allow other routers to put themselves in the chain before or after us.
    tmpDir:  os.tmpdir(),
    baseDir: "@expand:path.resolve({that}.options.tmpDir, {that}.id)",
    expressPouchLogFilename:    "@expand:fluid.pouch.express.generateUniqueLogPath({that})",
    expressPouchLogPath:        "@expand:path.resolve({that}.options.baseDir, {that}.options.expressPouchLogFilename)",
    expressPouchConfig: {
        inMemoryConfig: true,
        mode: "minimumForPouchDB",
        overrideMode: {
            exclude: [
                "routes/changes" // Disable the unused changes API to avoid a leaked listener.
            ]
        },
        logPath: "{that}.options.expressPouchLogPath"
    },
    events: {
        initDbs:           null,
        onError:           null,
        onStarted:         null,
        onCleanup:         null,
        onCleanupComplete: null
    },
    members: {
        baseDirBelongsToUs: false, // Whether we created our working directory (and thus should clean it up when we're done).
        databaseInstances: {} // The actual PouchDB databases
    },
    pouchGradeNames: ["fluid.pouch.node.base"],
    databases: {}, // The configuration we will use to create the required databases on startup.
    listeners: {
        "initDbs.initExpressPouchdb": {
            priority: "first",
            funcName: "fluid.pouch.express.initExpressPouchdb",
            args:     ["{that}"]
        },
        "initDbs.initDbs": {
            priority: "last",
            func:     "{that}.initDbs"
        },
        "onCreate.initDbs": {
            func: "{that}.events.initDbs.fire"
        },
        "onCleanup.cleanup": {
            func: "{that}.cleanup"
        },
        "onCreate.log": {
            funcName: "fluid.log",
            args: ["express baseDir: '", "{that}.options.baseDir", "'..."]
        }
    },
    invokers: {
        destroyDbs: "fluid.pouch.express.destroyDbs({that})",
        middleware: {
            funcName: "fluid.pouch.express.middleware",
            args:     ["{that}", "{arguments}.0", "{arguments}.1", "{arguments}.2"] // request, response, next
        }
    }
});

fluid.defaults("fluid.pouch.express", {
    gradeNames: ["fluid.pouch.express.base"],
    pouchGradeNames: ["fluid.pouch.node"],
    rimrafTimeout: 1000,
    dbOptions: {
        prefix: "@expand:fluid.pouch.node.makeSafePrefix({that}.options.baseDir)"
    },
    invokers: {
        cleanup: {
            funcName: "fluid.pouch.express.cleanup",
            args:     ["{that}"]
        },
        initDbs: {
            funcName: "fluid.pouch.express.initDbs",
            args:     ["{that}"]
        }
    }
});
