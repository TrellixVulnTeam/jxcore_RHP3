// npm install <pkg> <pkg> <pkg>
//
// See doc/install.md for more description

// Managing contexts...
// there's a lot of state associated with an "install" operation, including
// packages that are already installed, parent packages, current shrinkwrap, and
// so on. We maintain this state in a "context" object that gets passed around.
// every time we dive into a deeper node_modules folder, the "family" list that
// gets passed along uses the previous "family" list as its __proto__.  Any
// "resolved precise dependency" things that aren't already on this object get
// added, and then that's passed to the next generation of installation.

module.exports = install

install.usage = "npm install"
              + "\nnpm install <pkg>"
              + "\nnpm install <pkg>@<tag>"
              + "\nnpm install <pkg>@<version>"
              + "\nnpm install <pkg>@<version range>"
              + "\nnpm install <folder>"
              + "\nnpm install <tarball file>"
              + "\nnpm install <tarball url>"
              + "\nnpm install <git:// url>"
              + "\nnpm install <github username>/<github project>"
              + "\n\nCan specify one or more: npm install ./foo.tgz bar@stable /some/folder"
              + "\nIf no argument is supplied and ./npm-shrinkwrap.json is "
              + "\npresent, installs dependencies specified in the shrinkwrap."
              + "\nOtherwise, installs dependencies from ./package.json."

install.completion = function (opts, cb) {
  // install can complete to a folder with a package.json, or any package.
  // if it has a slash, then it's gotta be a folder
  // if it starts with https?://, then just give up, because it's a url
  // for now, not yet implemented.
  var registry = npm.registry
  
  registry.get("/-/short", function (er, pkgs) {
    if (er) return cb()
    if (!opts.partialWord) return cb(null, pkgs)

    var name = opts.partialWord.split("@").shift()
    pkgs = pkgs.filter(function (p) {
      return p.indexOf(name) === 0
    })

    if (pkgs.length !== 1 && opts.partialWord === name) {
      return cb(null, pkgs)
    }

    registry.get(pkgs[0], function (er, d) {
      if (er) return cb()
      return cb(null, Object.keys(d["dist-tags"] || {})
                .concat(Object.keys(d.versions || {}))
                .map(function (t) {
                  return pkgs[0] + "@" + t
                }))
    })
  });
}

var npm = require("./npm.js")
  , semver = require("semver")
  , readJson = require("read-package-json")
  , readInstalled = require("read-installed")
  , log = require("npmlog")
  , path = require("path")
  , fs = require("graceful-fs")
  , cache = require("./cache.js")
  , asyncMap = require("slide").asyncMap
  , chain = require("slide").chain
  , url = require("url")
  , mkdir = require("mkdirp")
  , lifecycle = require("./utils/lifecycle.js")
  , archy = require("archy")
  , isGitUrl = require("./utils/is-git-url.js")
  , npmInstallChecks = require("npm-install-checks")
  , sortedObject = require("sorted-object")

var autoremove_arr = null;
  
function install (args, cb_) {
  var hasArguments = !!args.length

  // do not change argument list here.
  // it corresponds to what save() is returning in callback
  var autoremove = function(er, installed, tree, pretty) {

    var _exit = function() {
      return cb_(er, installed, tree, pretty);
    };

    var autoremove_str = process.env.JX_NPM_AUTOREMOVE;
    if (!autoremove_str)
      return _exit();

    try {
      autoremove_arr = JSON.parse(autoremove_str);
    } catch(ex) {
      jxcore.utils.console.log("Cannot parse JX_NPM_AUTOREMOVE env variable.", "yellow");
      return _exit();
    }

    if (!autoremove_arr || !autoremove_arr.length)
      return _exit();

    var arr = [];

    for(var a in tree) {
      if (tree.hasOwnProperty(a)) {
        arr.push(a);
      }
    }

    if (!arr.length)
      return _exit();

    var cnt = 0;
    var local_cb = function() {
      cnt++;
      if (cnt === arr.length)
        _exit();
    };

    for(var a = 0, len = arr.length; a < len; a++) {
      delTree(arr[a], checkRemove, function() {
        local_cb()
      });
    }
  };

  function cb (er, installed) {
    if (er) return cb_(er)

    findPeerInvalid(where, function (er, problem) {
      if (er) return cb_(er)

      if (problem) {
        var peerInvalidError = new Error("The package " + problem.name +
          " does not satisfy its siblings' peerDependencies requirements!")
        peerInvalidError.code = "EPEERINVALID"
        peerInvalidError.packageName = problem.name
        peerInvalidError.peersDepending = problem.peersDepending
        return cb(peerInvalidError)
      }

      var tree = treeify(installed || [])
        , pretty = prettify(tree, installed).trim()

      if (pretty) console.log(pretty)
      save(where, installed, tree, pretty, hasArguments, autoremove)
    });
  }

  // the /path/to/node_modules/..
  var where = path.resolve(npm.dir, "..")

  // internal api: install(where, what, cb)
  if (arguments.length === 3) {
    where = args
    args = [].concat(cb_) // pass in [] to do default dep-install
    cb_ = arguments[2]
    log.verbose("install", "where,what", [where, args])
  }

  if (!npm.config.get("global")) {
    args = args.filter(function (a) {
      return path.resolve(a) !== where
    })
  }

  mkdir(where, function (er, made) {
    if (er) return cb(er)
    // install dependencies locally by default,
    // or install current folder globally
    if (!args.length) {
      var opt = { dev: npm.config.get("dev") || !npm.config.get("production") }

      if (npm.config.get("global")) args = ["."]
      else return readDependencies(null, where, opt, function (er, data) {
        if (er) {
          log.error("install", "Couldn't read dependencies")
          return cb(er)
        }
        var deps = Object.keys(data.dependencies || {})
        log.verbose("install", "where, deps", [where, deps])
        var context = { family: {}
                      , ancestors: {}
                      , explicit: false
                      , parent: data
                      , root: true
                      , wrap: null }

        if (data.name === path.basename(where) &&
            path.basename(path.dirname(where)) === "node_modules") {
          // Only include in ancestry if it can actually be required.
          // Otherwise, it does not count.
          context.family[data.name] =
            context.ancestors[data.name] = data.version
        }

        installManyTop(deps.map(function (dep) {
          var target = data.dependencies[dep]
            , parsed = url.parse(target.replace(/^git\+/, "git"))
          target = dep + "@" + target
          return target
        }), where, context, function(er, results) {
          if (er) return cb(er, results)
          lifecycle(data, "prepublish", where, function(er) {
            return cb(er, results)
          })
        })
      })
    }

    // initial "family" is the name:version of the root, if it's got
    // a package.json file.
    var jsonFile = path.resolve(where, "package.json")
    readJson(jsonFile, log.warn, function (er, data) {
      if (er
          && er.code !== "ENOENT"
          && er.code !== "ENOTDIR") return cb(er)
      if (er) data = null
      var context = { family: {}
                    , ancestors: {}
                    , explicit: true
                    , parent: data
                    , root: true
                    , wrap: null };
      
      if (data && data.name === path.basename(where) &&
          path.basename(path.dirname(where)) === "node_modules") {
        context.family[data.name] = context.ancestors[data.name] = data.version
      }
      var fn = npm.config.get("global") ? installMany : installManyTop
      fn(args, where, context, cb);
    });
  });
}

function findPeerInvalid (where, cb) {
  readInstalled(where, { log: log.warn, dev: true }, function (er, data) {
    if (er) return cb(er)

    cb(null, findPeerInvalid_(data.dependencies, []))
  })
}

function findPeerInvalid_ (packageMap, fpiList) {
  if (fpiList.indexOf(packageMap) !== -1)
    return

  fpiList.push(packageMap)

  for (var packageName in packageMap) {
    var pkg = packageMap[packageName]

    if (pkg.peerInvalid) {
      var peersDepending = {};
      for (peerName in packageMap) {
        var peer = packageMap[peerName]
        if (peer.peerDependencies && peer.peerDependencies[packageName]) {
          peersDepending[peer.name + "@" + peer.version] =
            peer.peerDependencies[packageName]
        }
      }
      return { name: pkg.name, peersDepending: peersDepending }
    }

    if (pkg.dependencies) {
      var invalid = findPeerInvalid_(pkg.dependencies, fpiList)
      if (invalid)
        return invalid
    }
  }

  return null
}

// reads dependencies for the package at "where". There are several cases,
// depending on our current state and the package's configuration:
//
// 1. If "context" is specified, then we examine the context to see if there's a
//    shrinkwrap there. In that case, dependencies are read from the shrinkwrap.
// 2. Otherwise, if an npm-shrinkwrap.json file is present, dependencies are
//    read from there.
// 3. Otherwise, dependencies come from package.json.
//
// Regardless of which case we fall into, "cb" is invoked with a first argument
// describing the full package (as though readJson had been used) but with
// "dependencies" read as described above. The second argument to "cb" is the
// shrinkwrap to use in processing this package's dependencies, which may be
// "wrap" (in case 1) or a new shrinkwrap (in case 2).
function readDependencies (context, where, opts, cb) {
  var wrap = context ? context.wrap : null

  readJson( path.resolve(where, "package.json")
          , log.warn
          , function (er, data) {
    if (er && er.code === "ENOENT") er.code = "ENOPACKAGEJSON"
    if (er)  return cb(er)

    if (opts && opts.dev) {
      if (!data.dependencies) data.dependencies = {}
      Object.keys(data.devDependencies || {}).forEach(function (k) {
        data.dependencies[k] = data.devDependencies[k]
      })
    }

    if (!npm.config.get("optional") && data.optionalDependencies) {
      Object.keys(data.optionalDependencies).forEach(function (d) {
        delete data.dependencies[d]
      })
    }

    // User has opted out of shrinkwraps entirely
    if (npm.config.get("shrinkwrap") === false)
      return cb(null, data, null)

    if (wrap) {
      log.verbose("readDependencies: using existing wrap", [where, wrap])
      var rv = {}
      Object.keys(data).forEach(function (key) {
        rv[key] = data[key]
      })
      rv.dependencies = {}
      Object.keys(wrap).forEach(function (key) {
        log.verbose("from wrap", [key, wrap[key]])
        rv.dependencies[key] = readWrap(wrap[key])
      })
      log.verbose("readDependencies returned deps", rv.dependencies)
      return cb(null, rv, wrap)
    }

    var wrapfile = path.resolve(where, "npm-shrinkwrap.json")

    fs.readFile(wrapfile, "utf8", function (er, wrapjson) {
      if (er) {
        log.verbose("readDependencies", "using package.json deps")
        return cb(null, data, null)
      }

      try {
        var newwrap = JSON.parse(wrapjson)
      } catch (ex) {
        return cb(ex)
      }

      log.info("shrinkwrap", "file %j", wrapfile)
      var rv = {}
      Object.keys(data).forEach(function (key) {
        rv[key] = data[key]
      })
      rv.dependencies = {}
      Object.keys(newwrap.dependencies || {}).forEach(function (key) {
        rv.dependencies[key] = readWrap(newwrap.dependencies[key])
      })

      // fold in devDependencies if not already present, at top level
      if (opts && opts.dev) {
        Object.keys(data.devDependencies || {}).forEach(function (k) {
          rv.dependencies[k] = rv.dependencies[k] || data.devDependencies[k]
        })
      }

      log.verbose("readDependencies returned deps", rv.dependencies)
      return cb(null, rv, newwrap.dependencies)
    })
  })
}

function readWrap (w) {
  return (w.resolved) ? w.resolved
       : (w.from && url.parse(w.from).protocol) ? w.from
       : w.version
}

// if the -S|--save option is specified, then write installed packages
// as dependencies to a package.json file.
// This is experimental.
function save (where, installed, tree, pretty, hasArguments, cb) {
  if (!hasArguments ||
      !npm.config.get("save") &&
      !npm.config.get("save-dev") &&
      !npm.config.get("save-optional") ||
      npm.config.get("global")) {
    return cb(null, installed, tree, pretty)
  }

  var saveBundle = npm.config.get('save-bundle')
  var savePrefix = npm.config.get('save-prefix') || "^";

  // each item in the tree is a top-level thing that should be saved
  // to the package.json file.
  // The relevant tree shape is { <folder>: {what:<pkg>} }
  var saveTarget = path.resolve(where, "package.json")
    , things = Object.keys(tree).map(function (k) {
        // if "what" was a url, then save that instead.
        var t = tree[k]
          , u = url.parse(t.from)
          , w = t.what.split("@")
        if (u && u.protocol) w[1] = t.from
        return w
      }).reduce(function (set, k) {
        var rangeDescriptor = semver.valid(k[1], true) &&
                              semver.gte(k[1], "0.1.0", true) &&
                              !npm.config.get("save-exact")
                            ? savePrefix : ""
        set[k[0]] = rangeDescriptor + k[1]
        return set
      }, {})

  // don't use readJson, because we don't want to do all the other
  // tricky npm-specific stuff that's in there.
  fs.readFile(saveTarget, function (er, data) {
    // ignore errors here, just don't save it.
    try {
      data = JSON.parse(data.toString("utf8"))
    } catch (ex) {
      er = ex
    }

    if (er) {
      return cb(null, installed, tree, pretty)
    }

    var deps = npm.config.get("save-optional") ? "optionalDependencies"
             : npm.config.get("save-dev") ? "devDependencies"
             : "dependencies"

    if (saveBundle) {
      var bundle = data.bundleDependencies || data.bundledDependencies
      delete data.bundledDependencies
      if (!Array.isArray(bundle)) bundle = []
      data.bundleDependencies = bundle.sort()
    }

    log.verbose('saving', things)
    data[deps] = data[deps] || {}
    Object.keys(things).forEach(function (t) {
      data[deps][t] = things[t]
      if (saveBundle) {
        var i = bundle.indexOf(t)
        if (i === -1) bundle.push(t)
        data.bundleDependencies = bundle.sort()
      }
    })

    data[deps] = sortedObject(data[deps])

    data = JSON.stringify(data, null, 2) + "\n"
    fs.writeFile(saveTarget, data, function (er) {
      cb(er, installed, tree, pretty)
    })
  })
}


// Outputting *all* the installed modules is a bit confusing,
// because the length of the path does not make it clear
// that the submodules are not immediately require()able.
// TODO: Show the complete tree, ls-style, but only if --long is provided
function prettify (tree, installed) {
  if (npm.config.get("json")) {
    function red (set, kv) {
      set[kv[0]] = kv[1]
      return set
    }

    tree = Object.keys(tree).map(function (p) {
      if (!tree[p]) return null
      var what = tree[p].what.split("@")
        , name = what.shift()
        , version = what.join("@")
        , o = { name: name, version: version, from: tree[p].from }
      o.dependencies = tree[p].children.map(function P (dep) {
         var what = dep.what.split("@")
           , name = what.shift()
           , version = what.join("@")
           , o = { version: version, from: dep.from }
         o.dependencies = dep.children.map(P).reduce(red, {})
         return [name, o]
       }).reduce(red, {})
       return o
    })

    return JSON.stringify(tree, null, 2)
  }
  if (npm.config.get("parseable")) return parseable(installed)

  return Object.keys(tree).map(function (p) {
    return archy({ label: tree[p].what + " " + p
                 , nodes: (tree[p].children || []).map(function P (c) {
                     if (npm.config.get("long")) {
                       return { label: c.what, nodes: c.children.map(P) }
                     }
                     var g = c.children.map(function (g) {
                       return g.what
                     }).join(", ")
                     if (g) g = " (" + g + ")"
                     return c.what + g
                   })
                 }, "", { unicode: npm.config.get("unicode") })
  }).join("\n")
}

function parseable (installed) {
  var long = npm.config.get("long")
    , cwd = process.cwd()
  return installed.map(function (item) {
    return path.resolve(cwd, item[1]) +
         ( long ?  ":" + item[0] : "" )
  }).join("\n")
}

function treeify (installed) {
  // each item is [what, where, parent, parentDir]
  // If no parent, then report it.
  // otherwise, tack it into the parent's children list.
  // If the parent isn't a top-level then ignore it.
  var whatWhere = installed.reduce(function (l, r) {
    var parentDir = r[3]
      , parent = r[2]
      , where = r[1]
      , what = r[0]
      , from = r[4]
    l[where] = { parentDir: parentDir
               , parent: parent
               , children: []
               , where: where
               , what: what
               , from: from }
    return l
  }, {})

  // log.warn("install", whatWhere, "whatWhere")
  return Object.keys(whatWhere).reduce(function (l, r) {
    var ww = whatWhere[r]
    //log.warn("r, ww", [r, ww])
    if (!ww.parent) {
      l[r] = ww
    } else {
      var p = whatWhere[ww.parentDir]
      if (p) p.children.push(ww)
      else l[r] = ww
    }
    return l
  }, {})
}


// just like installMany, but also add the existing packages in
// where/node_modules to the family object.
function installManyTop (what, where, context, cb_) {
  function cb (er, d) {
    if (context.explicit || er) return cb_(er, d)
    // since this wasn't an explicit install, let's build the top
    // folder, so that `npm install` also runs the lifecycle scripts.
    npm.commands.build([where], false, true, function (er) {
      return cb_(er, d)
    })
  }

  if (context.explicit) return next()

  readJson(path.join(where, "package.json"), log.warn, function (er, data) {
    if (er) return next(er)
    lifecycle(data, "preinstall", where, next)
  })

  function next (er) {
    if (er) return cb(er)
    installManyTop_(what, where, context, cb)
  }
}

function installManyTop_ (what, where, context, cb) {
  var nm = path.resolve(where, "node_modules")
    , names = context.explicit
            ? what.map(function (w) { return w.split(/@/).shift() })
            : []

  fs.readdir(nm, function (er, pkgs) {
    if (er) return installMany(what, where, context, cb)
    pkgs = pkgs.filter(function (p) {
      return !p.match(/^[\._-]/)
    })
    asyncMap(pkgs.map(function (p) {
      return path.resolve(nm, p, "package.json")
    }), function (jsonfile, cb) {
      readJson(jsonfile, log.warn, function (er, data) {
        if (er && er.code !== "ENOENT" && er.code !== "ENOTDIR") return cb(er)
        if (er) return cb(null, [])
        return cb(null, [[data.name, data.version]])
      })
    }, function (er, packages) {
      // if there's nothing in node_modules, then don't freak out.
      if (er) packages = []
      // add all the existing packages to the family list.
      // however, do not add to the ancestors list.
      packages.forEach(function (p) {
        context.family[p[0]] = p[1]
      })
      return installMany(what, where, context, cb)
    })
  })
}

function installMany (what, where, context, cb) {
  // readDependencies takes care of figuring out whether the list of
  // dependencies we'll iterate below comes from an existing shrinkwrap from a
  // parent level, a new shrinkwrap at this level, or package.json at this
  // level, as well as which shrinkwrap (if any) our dependencies should use.
  var opt = { dev: npm.config.get("dev") }
  readDependencies(context, where, opt, function (er, data, wrap) {
    if (er) data = {}

    var parent = data

    var d = data.dependencies || {}

    // if we're explicitly installing "what" into "where", then the shrinkwrap
    // for "where" doesn't apply. This would be the case if someone were adding
    // a new package to a shrinkwrapped package. (data.dependencies will not be
    // used here except to indicate what packages are already present, so
    // there's no harm in using that.)
    if (context.explicit) wrap = null

    // what is a list of things.
    // resolve each one.
    asyncMap( what
            , targetResolver(where, context, d)
            , function (er, targets) {

      if (er) return cb(er)

      // each target will be a data object corresponding
      // to a package, folder, or whatever that is in the cache now.
      var newPrev = Object.create(context.family)
        , newAnc = Object.create(context.ancestors)

      if (!context.root) {
        newAnc[data.name] = data.version
      }
      targets.forEach(function (t) {
        newPrev[t.name] = t.version
      })
      log.silly("resolved", targets)
      targets.filter(function (t) { return t }).forEach(function (t) {
        log.info("install", "%s into %s", t._id, where)
      })
      asyncMap(targets, function (target, cb) {
        log.info("installOne", target._id)
        var wrapData = wrap ? wrap[target.name] : null
        var newWrap = wrapData && wrapData.dependencies
                    ? wrap[target.name].dependencies || {}
                    : null
        var newContext = { family: newPrev
                         , ancestors: newAnc
                         , parent: parent
                         , explicit: false
                         , wrap: newWrap }
        installOne(target, where, newContext, cb)
      }, cb)
    })
  })
}

function targetResolver (where, context, deps) {
  var alreadyInstalledManually = context.explicit ? [] : null
    , nm = path.resolve(where, "node_modules")
    , parent = context.parent
    , wrap = context.wrap

  if (!context.explicit) fs.readdir(nm, function (er, inst) {
    if (er) return alreadyInstalledManually = []

    // don't even mess with non-package looking things
    inst = inst.filter(function (p) {
      return !p.match(/^[\._-]/)
    })

    asyncMap(inst, function (pkg, cb) {
      readJson(path.resolve(nm, pkg, "package.json"), log.warn, function (er, d) {
        if (er && er.code !== "ENOENT" && er.code !== "ENOTDIR") return cb(er)
        // error means it's not a package, most likely.
        if (er) return cb(null, [])

        // if it's a bundled dep, then assume that anything there is valid.
        // otherwise, make sure that it's a semver match with what we want.
        var bd = parent.bundleDependencies
        if (bd && bd.indexOf(d.name) !== -1 ||
            semver.satisfies(d.version, deps[d.name] || "*", true) ||
            deps[d.name] === d._resolved) {
          return cb(null, d.name)
        }

        // see if the package had been previously linked
        fs.lstat(path.resolve(nm, pkg), function(err, s) {
          if (err) return cb(null, [])
          if (s.isSymbolicLink()) {
            return cb(null, d.name)
          }

          // something is there, but it's not satisfactory.  Clobber it.
          return cb(null, [])
        })
      })
    }, function (er, inst) {
      // this is the list of things that are valid and should be ignored.
      alreadyInstalledManually = inst
    })
  })

  var to = 0
  return function resolver (what, cb) {
    if (!alreadyInstalledManually) return setTimeout(function () {
      resolver(what, cb)
    }, to++)

    // now we know what's been installed here manually,
    // or tampered with in some way that npm doesn't want to overwrite.
    if (alreadyInstalledManually.indexOf(what.split("@").shift()) !== -1) {
      log.verbose("already installed", "skipping %s %s", what, where)
      return cb(null, [])
    }

    // check for a version installed higher in the tree.
    // If installing from a shrinkwrap, it must match exactly.
    if (context.family[what]) {
      if (wrap && wrap[what].version === context.family[what]) {
        log.verbose("shrinkwrap", "use existing", what)
        return cb(null, [])
      }
    }

    // if it's identical to its parent, then it's probably someone
    // doing `npm install foo` inside of the foo project.  Print
    // a warning, and skip it.
    if (parent && parent.name === what && !npm.config.get("force")) {
      log.warn("install", "Refusing to install %s as a dependency of itself"
              , what)
      return cb(null, [])
    }

    if (wrap) {
      var name = what.split(/@/).shift()
      if (wrap[name]) {
        var wrapTarget = readWrap(wrap[name])
        what = name + "@" + wrapTarget
      } else {
        log.verbose("shrinkwrap", "skipping %s (not in shrinkwrap)", what)
      }
    } else if (deps[what]) {
      what = what + "@" + deps[what]
    }

    // This is where we actually fetch the package, if it's not already
    // in the cache.
    // If it's a git repo, then we want to install it, even if the parent
    // already has a matching copy.
    // If it's not a git repo, and the parent already has that pkg, then
    // we can skip installing it again.
    cache.add(what, null, false, function (er, data) {
      if (er && parent && parent.optionalDependencies &&
          parent.optionalDependencies.hasOwnProperty(what.split("@")[0])) {
        log.warn("optional dep failed, continuing", what)
        log.verbose("optional dep failed, continuing", [what, er])
        return cb(null, [])
      }

      var isGit = false
        , maybeGit = what.split("@").slice(1).join()

      if (maybeGit)
        isGit = isGitUrl(url.parse(maybeGit))

      if (!er &&
          data &&
          !context.explicit &&
          context.family[data.name] === data.version &&
          !npm.config.get("force") &&
          !isGit) {
        log.info("already installed", data.name + "@" + data.version)
        return cb(null, [])
      }

      if (data && !data._from) data._from = what
      if (er && parent && parent.name) er.parent = parent.name
      return cb(er, data || [])
    })
  }
}

// we've already decided to install this.  if anything's in the way,
// then uninstall it first.
function installOne (target, where, context, cb) {
  // the --link flag makes this a "link" command if it's at the
  // the top level.
  if (where === npm.prefix && npm.config.get("link")
      && !npm.config.get("global")) {
    return localLink(target, where, context, cb)
  }
  installOne_(target, where, context, function (er, installedWhat) {

    // check if this one is optional to its parent.
    if (er && context.parent && context.parent.optionalDependencies &&
        context.parent.optionalDependencies.hasOwnProperty(target.name)) {
      log.warn("optional dep failed, continuing", target._id)
      log.verbose("optional dep failed, continuing", [target._id, er])
      er = null
    }

    cb(er, installedWhat)
  })

}

function localLink (target, where, context, cb) {
  log.verbose("localLink", target._id)
  var jsonFile = path.resolve( npm.globalDir, target.name
                             , "package.json" )
    , parent = context.parent

  readJson(jsonFile, log.warn, function (er, data) {
    if (er && er.code !== "ENOENT" && er.code !== "ENOTDIR") return cb(er)
    if (er || data._id === target._id) {
      if (er) {
        install( path.resolve(npm.globalDir, "..")
               , target._id
               , function (er) {
          if (er) return cb(er, [])
          thenLink()
        })
      } else thenLink()

      function thenLink () {
        npm.commands.link([target.name], function (er, d) {
          log.silly("localLink", "back from link", [er, d])
          cb(er, [resultList(target, where, parent && parent._id)])
        })
      }

    } else {
      log.verbose("localLink", "install locally (no link)", target._id)
      installOne_(target, where, context, cb)
    }
  })
}

function resultList (target, where, parentId) {
  var nm = path.resolve(where, "node_modules")
    , targetFolder = path.resolve(nm, target.name)
    , prettyWhere = where

  
  if (!npm.config.get("global")) {
    prettyWhere = path.relative(process.cwd(), where)
  }

  if (prettyWhere === ".") prettyWhere = null

  if (!npm.config.get("global")) {
    // print out the folder relative to where we are right now.
    targetFolder = path.relative(process.cwd(), targetFolder)
  }

  return [ target._id
         , targetFolder
         , prettyWhere && parentId
         , parentId && prettyWhere
         , target._from ]
}

// name => install locations
var installOnesInProgress = Object.create(null)

function isIncompatibleInstallOneInProgress(target, where) {
  return target.name in installOnesInProgress &&
         installOnesInProgress[target.name].indexOf(where) !== -1
}

function installOne_ (target, where, context, cb) {
  var nm = path.resolve(where, "node_modules")
    , targetFolder = path.resolve(nm, target.name)
    , prettyWhere = path.relative(process.cwd(), where)
    , parent = context.parent

  if (prettyWhere === ".") prettyWhere = null

  if (isIncompatibleInstallOneInProgress(target, where)) {
    var prettyTarget = path.relative(process.cwd(), targetFolder)

    // just call back, with no error.  the error will be detected in the
    // final check for peer-invalid dependencies
    return cb()
  }

  if (!(target.name in installOnesInProgress)) {
    installOnesInProgress[target.name] = []
  }
  installOnesInProgress[target.name].push(where)
  var indexOfIOIP = installOnesInProgress[target.name].length - 1
    , force = npm.config.get("force")
    , nodeVersion = npm.config.get("node-version")
    , strict = npm.config.get("engine-strict")
    , c = npmInstallChecks

  chain
    ( [ [c.checkEngine, target, npm.version, nodeVersion, force, strict]
      , [c.checkPlatform, target, force]
      , [c.checkCycle, target, context.ancestors]
      , [c.checkGit, targetFolder]
      , [write, target, targetFolder, context] ]
    , function (er, d) {
        installOnesInProgress[target.name].splice(indexOfIOIP, 1)

        if (er) return cb(er)

        d.push(resultList(target, where, parent && parent._id))
        cb(er, d)
      }
    )
}

function write (target, targetFolder, context, cb_) {
  var up = npm.config.get("unsafe-perm")
    , user = up ? null : npm.config.get("user")
    , group = up ? null : npm.config.get("group")
    , family = context.family

  function cb (er, data) {
    // cache.unpack returns the data object, and all we care about
    // is the list of installed packages from that last thing.
    if (!er) return cb_(er, data)

    if (false === npm.config.get("rollback")) return cb_(er)
    npm.commands.unbuild([targetFolder], true, function (er2) {
      if (er2) log.error("error rolling back", target._id, er2)
      return cb_(er, data)
    })
  }

  var bundled = [];
  
  function clear_files(folder){
	  var files = fs.readdirSync(folder);

	  var isWindows = process.platform === "win32";
	  for(var o in files){
	    var name = files[o];

	    var stat = fs.statSync(folder + path.sep + name);
	    
	    if(!stat.isDirectory()){
	      var _ext = path.extname(name);
		  if(_ext)
			_ext = _ext.toLowerCase().trim();
		  else
			_ext = "";
	      if(stat.size > 1e6 || _ext == ".node" || _ext == ".dll")
	    	  continue;

            var fstr = fs.readFileSync(folder + path.sep + name) +"";
            var ln = fstr.length;

			if(_ext == ".cmd" || _ext == ".bat")
			{
			  fstr = fstr.replace(/node.exe/g, "jx.cmd");
			  fstr = fstr.replace(/node /g, "jx ");
			}
            else if(_ext == ".gyp"){
                fstr = fstr.replace(/node[ ]*-e[ ]*"require/g, "jx -e \"require");
                fstr = fstr.replace(/node[ ]*-e[ ]*'require/g, "jx -e 'require");
            }
		    else{
			  fstr = fstr.replace(/#![ ]*\/usr\/bin\/env[ ]*node/, "#!/usr/bin/env jx");
			  if(fstr.indexOf("#!/bin/sh")>=0 || fstr.indexOf("#! /bin/sh")>=0 || fstr.indexOf("#!/bin/bash")>=0){
			    fstr = fstr.replace(/node[ ]+/g, "jx ");
			    fstr = fstr.replace(/"$basedir\/node"/g, '"$basedir/jx"');
                fstr = fstr.replace(/'$basedir\/node'/g, "'$basedir/jx'");
			  }
		    }

            if(fstr.length != ln){
                fs.writeFileSync(folder + path.sep + name, fstr);
            }

	    }else{
	      
	      if(stat.isDirectory()){
	        clear_files(folder + path.sep + name);
	      }
	    }
	  }
	}
  
  fs.pre_clear = function(targetFolder, target, cb){
	  fs.writeFile(path.resolve(targetFolder, "package.json"), JSON.stringify(target, null, 2) + "\n", cb );
	  clear_files(targetFolder);
  }
  
  //console.log("!!!", targetFolder, npm.config.get("global"));
  

  chain
    ( [ [ cache.unpack, target.name, target.version, targetFolder
        , null, null, user, group ]
      , [ fs, "pre_clear"
        , targetFolder
        , target ]
      , [ lifecycle, target, "preinstall", targetFolder ]
      , function (cb) {
          if (!target.bundleDependencies) return cb()

          var bd = path.resolve(targetFolder, "node_modules")
          fs.readdir(bd, function (er, b) {
            // nothing bundled, maybe
            if (er) return cb()
            bundled = b || []
            cb()
          })
        } ]

    // nest the chain so that we can throw away the results returned
    // up until this point, since we really don't care about it.
    , function X (er) {
      if (er) return cb(er)

      // before continuing to installing dependencies, check for a shrinkwrap.
      var opt = { dev: npm.config.get("dev") }
      readDependencies(context, targetFolder, opt, function (er, data, wrap) {
        var deps = prepareForInstallMany(data, "dependencies", bundled, wrap,
            family)
        var depsTargetFolder = targetFolder
        var depsContext = { family: family
                          , ancestors: context.ancestors
                          , parent: target
                          , explicit: false
                          , wrap: wrap }

        var peerDeps = prepareForInstallMany(data, "peerDependencies", bundled,
            wrap, family)
        var pdTargetFolder = path.resolve(targetFolder, "..", "..")
        var pdContext = context;

        var actions =
          [ [ installManyAndBuild, deps, depsTargetFolder, depsContext ] ]

        if (peerDeps.length > 0) {
          actions.push(
            [ installMany, peerDeps, pdTargetFolder, pdContext ]
          )
        }

        chain(actions, cb)
      })
    })
}

function installManyAndBuild (deps, targetFolder, context, cb) {
  installMany(deps, targetFolder, context, function (er, d) {
    log.verbose("about to build", targetFolder)
    if (er) return cb(er)
    npm.commands.build( [targetFolder]
                      , npm.config.get("global")
                      , true
                      , function (er) { return cb(er, d) })
  })
}

function prepareForInstallMany (packageData, depsKey, bundled, wrap, family) {
  var deps = Object.keys(packageData[depsKey] || {})

  // don't install bundleDependencies, unless they're missing.
  if (packageData.bundleDependencies) {
    deps = deps.filter(function (d) {
      return packageData.bundleDependencies.indexOf(d) === -1 ||
             bundled.indexOf(d) === -1
    })
  }

  return deps.filter(function (d) {
    // prefer to not install things that are satisfied by
    // something in the "family" list, unless we're installing
    // from a shrinkwrap.
    if (wrap) return wrap
    if (semver.validRange(family[d], true))
      return !semver.satisfies(family[d], packageData[depsKey][d], true)
    return true
  }).map(function (d) {
    var t = packageData[depsKey][d]
      , parsed = url.parse(t.replace(/^git\+/, "git"))
    t = d + "@" + t
    return t
  })
}

var delTree = function(loc, checkRemove, cb) {
  var cc = jxcore.utils.console;
  if (fs.existsSync(loc)) {
    var _files = fs.readdirSync(loc);
    var _removed = 0;
    for ( var o in _files) {
      if (!_files.hasOwnProperty(o))
        continue;

      var file = _files[o];
      var _path = loc + path.sep + file;
      if (!fs.lstatSync(_path).isDirectory()) {
        try {
          var removeFile = checkRemove
            && checkRemove(loc, file, _path, false);
          if (!checkRemove || removeFile) {
            fs.unlinkSync(_path);
            _removed++;
            if (removeFile)
              cc.log("--autoremove:", _path.replace(process.cwd(), '.'),
                "yellow");
          }
        } catch (e) {
          cc.write("Permission denied ", "red");
          cc.write(loc, "yellow");
          cc.log(" (do you have a write access to this location?)");
        }
        continue;
      }
      // folders
      var removeDir = checkRemove && checkRemove(loc, file, _path, true);
      if (!checkRemove || removeDir) {
        delTree(_path);
        if (removeDir)
          cc.log("--autoremove:", _path.replace(process.cwd(), '.'),
            "yellow");
      } else {
        delTree(_path, checkRemove);
      }
    }

    if (!checkRemove || _removed == _files.length)
      fs.rmdirSync(loc);
  }

  if (cb)
    cb();
};

// makes decision, whether remove file/folder or not
var checkRemove = function(folder, file, _path, isDir) {

  var specials = [ "\\", "^", "$", ".", "|", "+", "(", ")", "[", "]",
    "{", "}" ]; // without '*' and '?'

  for ( var o in autoremove_arr) {
    if (!autoremove_arr.hasOwnProperty(o))
      continue;

    var mask = autoremove_arr[o];
    var isPath = mask.indexOf(path.sep) !== -1;

    // entire file/folder basename compare
    if (mask === file)
      return true;

    // compare against entire path (without process.cwd)
    if (isPath
      && _path.replace(process.cwd(), "").indexOf(mask) !== -1)
      return true;

    // regexp check against * and ?
    var r = mask;
    for ( var i in specials) {
      if (specials.hasOwnProperty(i))
        r = r.replace(new RegExp("\\" + specials[i], "g"), "\\"
        + specials[i]);
    }

    var r = r.replace(/\*/g, '.*').replace(/\?/g, '.{1,1}');
    var rg1 = new RegExp('^' + r + '$');
    var rg2 = new RegExp('^' + path.join(folder, r) + '$');
    if (rg1.test(file) || rg2.test(_path))
      return true;
  }

  return false;
};

