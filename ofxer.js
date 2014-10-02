var spawn = require('child_process').spawn,
child;
var fs = require('fs');
var ofx = require('ofx');
var argv = require("minimist")(
  process.argv.slice(2),
  { string: [ 'f', 'l', 'key', 'o' ],
    boolean: [ 'train', 'save' ]
  }
);
var moment = require('moment');
var _ = require('lodash-node');
var async = require('async');
var classifier = require('classifier');
var prompt = require('prompt');
var sprintf = require('sprintf-js').sprintf;
var colors = require('colors');
var amountMeta = require(__dirname+'/funcs.js').amountMeta;
var Xact = require(__dirname+'/funcs.js').Xact;
var dp2date = require(__dirname+'/funcs.js').dp2date;
var stripXact = require(__dirname+'/funcs.js').stripXact;
var doTrain = require(__dirname+'/funcs.js').doTrain;
var getClassifier = require(__dirname+'/funcs.js').getClassifier;
var exDist = require(__dirname+'/funcs.js').exDist;
var dtf = "YYYY-MM-DD"
var ynpatt = /^(y(es)?|no?)\s*$/i

if ( ! argv.key ) {
  throw new Error("GOTTA SPECIFY THE FILE KEY")
}

colors.setTheme({
  info: 'blue',
  candidate: 'yellow',
  trial: 'yellow',
  selected: 'green'
});

// Closure
(function(){

	/**
	 * Decimal adjustment of a number.
	 *
	 * @param	{String}	type	The type of adjustment.
	 * @param	{Number}	value	The number.
	 * @param	{Integer}	exp		The exponent (the 10 logarithm of the adjustment base).
	 * @returns	{Number}			The adjusted value.
	 */
	function decimalAdjust(type, value, exp) {
		// If the exp is undefined or zero...
		if (typeof exp === 'undefined' || +exp === 0) {
			return Math[type](value);
		}
		value = +value;
		exp = +exp;
		// If the value is not a number or the exp is not an integer...
		if (isNaN(value) || !(typeof exp === 'number' && exp % 1 === 0)) {
			return NaN;
		}
		// Shift
		value = value.toString().split('e');
		value = Math[type](+(value[0] + 'e' + (value[1] ? (+value[1] - exp) : -exp)));
		// Shift back
		value = value.toString().split('e');
		return +(value[0] + 'e' + (value[1] ? (+value[1] + exp) : exp));
	}

	// Decimal round
	if (!Math.round10) {
		Math.round10 = function(value, exp) {
			return decimalAdjust('round', value, exp);
		};
	}
	// Decimal floor
	if (!Math.floor10) {
		Math.floor10 = function(value, exp) {
			return decimalAdjust('floor', value, exp);
		};
	}
	// Decimal ceil
	if (!Math.ceil10) {
		Math.ceil10 = function(value, exp) {
			return decimalAdjust('ceil', value, exp);
		};
	}

})();


var fitdb = {}


function getAccounts(file,cb) {
  var args = _.flatten([["-f", file, "accounts"]]);

  if ( argv.verbose ) console.log("ledger ",_.map(args, function(a) { 
    return a.match(/-/) ? a : '"'+a+'"';
  }).join(" "))
  child = spawn('ledger',args)
  var data = ""
  var errdata = ""

  child.stderr.on('data',function(buf) {
    errdata += buf.toString()
  })


  child.stdout.on('data',function(buf) {
    data += buf.toString()
  })

  child.on("close",function(code) {
    if ( argv.verbose ) console.log("CODE: "+code)
    if ( errdata ) {
      console.log(errdata)
      process.exit(1)
    }
    cb(data.split(/\n/))
  })
}

function processLedger(file, acct, cond, opts, cb) {

  var mycond = 'account=~/'+acct+'/'
  if ( cond ) mycond += "and ("+cond+")";

  var args = _.flatten([["-f", file, "xml", "--limit", mycond, "-r", "--sort", "date"], opts]);

  if ( argv.verbose ) console.log("ledger ",_.map(args, function(a) { 
    return a.match(/-/) ? a : '"'+a+'"';
  }).join(" "))
  child = spawn('ledger',args)

  var data = ""
  var errdata = ""

  child.stderr.on('data',function(buf) {
    errdata += buf.toString()
  })


  child.stdout.on('data',function(buf) {
    data += buf.toString()
  })

  child.on("close",function(code) {
    if ( argv.verbose ) console.log("CODE: "+code)
    if ( errdata ) {
      console.log(errdata)
      process.exit(1)
    }
    var parseString = require('xml2js').parseString;
    parseString(data, function (err, ledger) {
      if ( err ) { console.log("ERROR PARSING XML: "+err); process.exit(1) }
      ledger = ledger.ledger
      cb(ledger)
    })
  })  
}

function ofx2ledger(dt, name, notes, acct, tamt, split, trial) {
  var line = [dt, name].join(' ')
  if ( trial )
    console.log(line.trial.trial)
  else
    console.log(line.trial)
  if ( notes && notes.length ) 
    console.log( '    ; '+notes.join("\n    ;"))
  var splits = [];
  _.each(split, function( s ) {
    var amt = -Math.round10(s.frac*tamt,-2)
    splits.push(sprintf("    %-60s    $%10.2f", s.name,amt))
  });
  if ( trial ) console.log(splits.join("\n").candidate);
  else console.log(splits.join("\n"));
  console.log(sprintf("    %-60s    $%10.2f", acct, tamt));
}

function mindent(s, ind) {
//  console.log("indenting ",s,"by","'"+ind+"'")
  return _.map(s.split(/\n/),function(ss) { return ind+ss }).join("\n")
}

function savexact(adds, file) {
  if ( adds.length == 0 ) return  // nothing to do
  if ( file === undefined ) throw new Error("Can't save to unspecified file")
  var str = fs.createWriteStream(file, {flags:'a+'})
  str.write("\n; ================================\n; Transactions added by ofxer "+moment().format()+"\n\n")
  _.each(adds, function(xact_add) {
    xact2ledger(xact_add, null, null, str)
    str.write("\n")
  })
  str.write("\n; ================================\n; END adding transactions "+moment().format())
  str.end("\n\n")
}

function xact2ledger(xact, status, indent, str) {
  var stra = str
  if ( stra === undefined ) {
    //stra = fs.createWriteStream('/dev/stdout',{flags:'a'})
  } else if ( typeof str == 'string' ) {
    str = undefined
    stra = fs.createWriteStream(stra,{flags:'a+'})
  }

  if (!indent) indent = ""
  function emit(str) {
    if ( stra === undefined ) {
      if ( status )
        console.log(mindent(str[status],indent))
      else
        console.log(mindent(str,indent))
    } else {
      if ( status )
        stra.write(mindent(str[status],indent)+"\n")
      else
        stra.write(mindent(str,indent)+"\n")
    }
  }
  function emitif(val) { if ( val !== undefined ) emit(val) }
  var ll = [moment(xact.date).format('YYYY-MM-DD')]
  if ( xact.num ) ll.push('('+xact.num+')')
  else if ( xact.code ) ll.push('('+xact.code+')')
  else if ( xact.fitid() ) ll.push('('+xact.fitid()+')')
  ll.push(xact.payee)
  emitif(ll.join(' '))
  if ( xact.note ) emit(mindent(xact.note,"    ;"))
  emitif(xact.memo?"    ; "+xact.memo:xact.memo)
  if ( xact.metadata ) 
    _.each(xact.metadata, function(v,k) { 
      emit(mindent([k,v].join(': '),'    ; ')); 
    });
  // FIXME: bug: xml doesn't give posting metadata
  _.each(xact.postings, function( p ) {
    //var amt = -Math.round10(s.frac*tamt,-2)
    if ( p.metadata ) _.each(p.metadata, function(v,k) { 
      emit(mindent([k,v].join(': '),'    ; ')); 
    });
  });

                                                                  
  var tamt = 0;
  _.each(xact.postings, function( p ) {
    //var amt = -Math.round10(s.frac*tamt,-2)
    emit(sprintf("    %-60s    $%10.2f", p.account.name, -p.amt.val))
    if ( p.metadata ) _.each(p.metadata, function(v,k) { 
      emit(mindent([k,v].join(': '),'    ; ')); 
    });
    if ( p.note ) {
      if ( typeof p.note == 'object' ) {
        emit(mindent(p.note.join(""),"    ;"))
      } else {
        emit(mindent(p.note,"    ;"))
      }
    }

    tamt += p.amt.val;
  });

  if ( str === null ) { 
    stra.end("")
  }
}

function ledger2split(acct, xact, expect) {
  var postings = xact.postings[0].posting;
  var tot = 0;
  _.each(postings,function(p) {
    tot += parseFloat(p['post-amount'][0].amount[0].quantity[0])
  });
  var val = []
  _.each(postings, function( p ) {
    
    // only record nonzero splits
    var pamt = parseFloat(p['post-amount'][0].amount[0].quantity[0])/tot
    if ( pamt != 0 ) {
      val.push( { name: p.account[0].name[0], frac: pamt } );
    }
  });
  if ( tot != expect ) {
    ofx2ledger(dp2date(xact.DTPOSTED), xact.NAME, [xact.MEMO, "FITID: "+xact.fitid()], val, true)
    throw new Error("total "+tot+" != expect "+expect);
  }
  return val;
}

var gacct = JSON.parse(fs.readFileSync("./accts.json"))


function processOFX(cb) {

  fs.readFile(argv.f, 'utf8', function(err, ofxData) {
    if ( err ) cb(err)

    var data = ofx.parse(ofxData);

    if ( argv.verbose ) console.log(data);

    cb(null, data)
  })
}

function ofx2stmt(ofx) {
  var stmt, pfx
  if ( ofx.OFX.BANKMSGSRSV1 ) {
    stmt = ofx.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS
    pfx  = "BANK";
  } else if ( ofx.OFX.CREDITCARDMSGSRSV1 ) { 
    stmt = ofx.OFX.CREDITCARDMSGSRSV1.CCSTMTTRNRS.CCSTMTRS
    pfx  = "CC";
  } else {
    console.log("UNRECOGNIZED OFX TYPE")
    process.exit(1);
  }
  
  if ( stmt === undefined ) {
    throw new Error("NO STMT DATA?");
  }
  return {stmt:stmt,pfx:pfx}
}

function readSplits(xacta,accounts,cb) {
  var xact = _.cloneDeep(xacta)

  var newsplit = []
  var left = xact.amount()
  async.whilst(
    function() { return Math.abs(left) > 0.009 },
    function(cbg) {
      async.whilst(
        function () { return true },
        function (cbw) {
          prompt.get({properties: {
            "account": {
              description: "Account for ["+left+"]",
              
              completer: function(line) {
                var completions = accounts
                var hits = completions.filter(function(c) { return c.indexOf(line) == 0 })
                // show all completions if none found
                return [hits.length ? hits : completions, line]
              }
              
            },
            "amount": {
              description: "    Amount",
              pattern: /^-?(\d?\d?\d(,\d\d\d)*|\d+)(\.\d\d)?$/,
              'default': (sprintf("%0.2f",left))
            }
          }}, function(err, res3) {
            if ( err ) cbg(err);
            if ( !_.find( accounts, function( a ) {return a == res3.account }) ) {
              prompt.get({properties: {
                "newac": {
                  description: "Use new account "+res3.account+"?",
                  pattern: /^(y(es)?|no?)\s*$/i,
                  required: true
                }
              }}, function(err, res4) {
                if ( res4.newac.match(/^y/i) ) {
                  var amt = parseFloat(res3.amount)
                  newsplit.push({account: { name:res3.account },
                                 amt: { cmdty: '$', val: -amt }})
                  left -= amt
                  // add new account to accounts
                  accounts.push(res3.account);
                  cbg();
                } else {
                  cbw()
                }
              })
            } else {
              var amt = parseFloat(res3.amount)
              newsplit.push({account: { name:res3.account },
                             amt: { cmdty: '$', val: -amt }})
              left -= amt
              cbg();
            }
          })
        }
      )
    },
    function whilstError(err) {
      newsplit.push(xact.postings.slice(-1)[0])  // add original
      xact.postings = newsplit;
      xact.metadata.source = "manual"
      
      cb(err, xact)
    });

}

function getacctkey(ofx) {
  var stmt = ofx2stmt(ofx).stmt
  var pfx  = ofx2stmt(ofx).pfx
  var acctkey;

  if ( pfx==="BANK" ) {
    acctkey = [stmt[pfx+"ACCTFROM"].BANKID,stmt[pfx+"ACCTFROM"].ACCTID].join(":");
  } else if ( pfx==="CC" ) {
    acctkey = [stmt[pfx+"ACCTFROM"].ACCTID].join(":");
  } else {
    throw new Error("UNRECOGNIZED ACCT ID")
  }
  return acctkey;
}

function getAccount(ofx, cb) {
  var acctkey
  try {
    acctkey = getacctkey(ofx);
  } catch (e) {
    cb(e)
  }
  var acct = gacct[acctkey];
  if ( acct == undefined ) cb("UNKNOWN ACCOUNT KEY "+acctkey)
  return acct
}

// Here's the main logic
async.waterfall([
  processOFX,

  function getAccountWrapper(ofx, cb) {
    acct = getAccount(ofx,cb);
    var err;
    if (acct == undefined) cb( "Unknown Account: "+acct )
    else 
      console.log( "GOT ACCOUNT "+JSON.stringify(acct).info )
    cb(null, ofx, acct)
  },

  function updateFitDb(ofx, acct, cb) {
    processLedger(argv.l, acct.acct, "", [], function( ledger ) {

      // update fitdb
      var transactions = ledger.transactions[0].transaction
      console.log((transactions?transactions.length:0)+" transactions in ledger");
      var cnt = 0;
      _.each(transactions, function(ledgerxact) {
        var xact = new Xact(ledgerxact, acct.acct)
        if ( xact.fitid() ) {
          fitdb[xact.fitid()] = xact;
        }
        _.each(xact.postings, function(p) {
          if ( p.metadata.fitid ) {
            console.log("GOT" +p.metadata.fitid)
            fitdb[p.metadata.fitid] = xact
          }
        })
      });

      if ( argv.verbose ) console.log("UPDATED FITDB".info)

      getAccounts(argv.l, function(accts) {
        ledger.accounts = accts
        cb(null,ofx, acct, ledger)
      })
    })
  },

  function findLedgerMatches(ofx, acct, ledger, cb) {
    var stmt = ofx2stmt(ofx).stmt
    var pfx  = ofx2stmt(ofx).pfx

    var adds = []

    async.eachSeries(stmt["BANKTRANLIST"].STMTTRN.reverse(), function( ofxxact, cb2 ) {
      var xact_ofx = new Xact(ofxxact, acct.acct)
      xact_ofx.postings[0].account = {name: 'unspecified'}
      xact_ofx.metadata.source = 'rawofx'
      console.log("\n===============================================\nOFX TRANSACTION...".red)
      xact2ledger(xact_ofx, 'trial', '   ')
      console.log("===============================================".red)


      var tkey = xact_ofx.tkey()

      if ( fitdb[xact_ofx.fitid()] ) {
        console.log([tkey,"already a transaction:",xact_ofx.fitid()].join(" ").info)
        xact2ledger(fitdb[xact_ofx.fitid()])
        cb2(null,fitdb[xact_ofx.fitid()])

      } else {

        if ( argv.verbose ) console.log("FINDING MATCHES".info)

        async.waterfall([

          function matchExisting(cb3) {
            if ( argv.verbose ) console.log("...EXISTING?".info)

            // see if matching transaction exists within one week on either side
            var amt = parseFloat(xact_ofx.amount())
            var b = xact_ofx.date.clone()
            b.subtract('days',7)
            var e = xact_ofx.date.clone()
            e.add('days',7)
            var window = Math.abs(amt)*0.25  // 5%
            processLedger(argv.l, acct.acct, "(amount>"+((-amt)-window)+") and (amount<"+((-amt)+window)+")", ['-b', b.format(dtf), '-e', e.format(dtf)], function(l2) {

              var existingsplits = []
              var lxacts = l2.transactions[0].transaction;
              if (argv.verbose) console.log("LXACTS:"+JSON.stringify(lxacts))
              _.each(lxacts,function(lxact) {  // loop over matching ledger xacts
                var xact_led = new Xact(lxact, acct.acct)
                existingsplits.push(xact_led)
              });
              existingsplits = existingsplits.sort(function(a,b) {
                return exDist(a,xact_ofx) - exDist(b,xact_ofx)
              })
              cb3(null, existingsplits);
            })
          },

          function bayesianMatch(exsplits, cb3) {
            if ( argv.verbose ) console.log("...BAYESIAN?".info)

            var bayes = getClassifier(argv.key, xact_ofx)

            bayes.classify(tkey, function(category) {
              if ( category === 'unclassified' ) {
                cb3(null, exsplits, null)

              } else {
                var xact_bayes = _.merge(new Xact(),xact_ofx);
                var guess = _.pick(JSON.parse(category), function(v,k) { return k.match(/^(postings)/)})
                _.merge(xact_bayes, guess)
                xact_bayes.date = moment(xact_bayes.date)
                // expand fractions to amounts from the OFX
                var tot = xact_ofx.total()
                _.each(xact_bayes.postings, function(p) {
                  p.amt.val = p.amt.val * tot
                });
                
                xact_bayes.metadata.source = 'bayes'
                if ( argv.verbose ) {
                  console.log(JSON.stringify(xact_bayes))
                  console.log(JSON.stringify(xact_bayes.targetpost()))
                  console.log(JSON.stringify(xact_bayes.targetpost().metadata))
                }
                var tp = xact_bayes.targetpost()
                if ( !tp.metadata ) tp.metadata = {}
                tp.metadata.fitid = xact_ofx.fitid()
                cb3(null, exsplits, xact_bayes)
              }
            })
          },

          function showOptions(exsplits, xact_bayes, cb3) {

            var cnt = 0;
            var choices = ["x","s"]
            var defaults = []

            _.each(exsplits, function(xact) {
              defaults.push(cnt)
              console.log(('   '+"\n"+cnt+") EXISTING TRANSACTION ["+exDist(xact,xact_ofx)+"]").info)
              xact2ledger(xact, 'trial', '   ')
              cnt++
            });
            if ( exsplits.length > 0 ) {
              choices.push('\\d+')
            }

            if ( xact_bayes ) {
              console.log('   '+"\nb) BEST BAYESIAN GUESS:".info)
              //ofx2ledger(dp2date(xact.DTPOSTED), xact.NAME, [xact.MEMO, "FITID: "+xact.fitid], parseFloat(xact.TRNAMT), true)
              xact2ledger(xact_bayes, 'trial', '   ')
              choices.push("b")
              defaults.push("b")
            }
            
            console.log('   '+"\ns) MANUALLY SPECIFY SPLITS".info)
            defaults.push("s")
            
            console.log('   '+"\nx) USE RAW OFX".info)
            defaults.push("x")

            patt = new RegExp("("+choices.join("|")+")","i")
            var dflt = defaults[0]

            prompt.start()
            prompt.get({
              properties: {
                'split': {
                  description: "Choose which split to apply",
                  pattern: patt,
                  message: 'Choose a <number> or x',
                  'default': dflt,
                  required: true
                }
              }
            }, function (err, result) {
              console.log("GOT ",result.split)
              cb3(err, exsplits, xact_bayes, result)
            })
          },

          function chooseMatch(exsplits, xact_bayes, result, cb3) {
            if ( result.split === 'x' ) {
              // cancel, unspecified
              
              //console.log(JSON.stringify(xact_ofx))
              cb3(null, xact_ofx)

            } else if ( result.split === 's' ) {
              console.log("Specify Splits...")
              // FIXME
              readSplits(xact_ofx, ledger.accounts, function(err, xact_new) {
                adds.push(xact_new)
                cb3(err, xact_new)
              });

            } else if ( result.split === 'b' ) {

              adds.push(xact_bayes)
              cb3(null, xact_bayes)

            } else {
              var splitno = parseInt(result.split)
              if ( (splitno) < exsplits.length ) {
                // chose existing split
                if ( argv.verbose ) console.log("CHOOSING EXISTING",splitno)

                var xact_existing   = exsplits[splitno]
                xact_existing.targetpost().metadata.fitid = xact_ofx.fitid()

                cb3(null, xact_existing)
                
              } else {
                cb3("SHOULDN'T GET HERE!")
              }
            }
          },

          function emitMatch(xact_chosen, cb3) {

            if ( argv.verbose ) console.log ( "Emitting match" )

            // apply FITID
            xact2ledger(xact_chosen, 'selected', '   ')

            cb3(null, xact_chosen)

          },

          function trainMatch(xact_chosen, cb3) {

            if ( argv.train && !(xact_chosen.metadata.source=="rawofx") ) {
              
              doTrain(argv.key, xact_chosen, function(err) {
                cb3(err, xact_chosen)
              });
            } else {
              cb3(null, xact_chosen)
            }
          }
          
        ], function matchError(err, result) {
          if ( err ) cb(err);
          cb2(null, result);
        })
      }
    }, function(err) {
      if ( err ) cb(err)
          
      // WRITE OUT ALL ADDS
      _.each(adds,function(xact_add) {
        xact2ledger(xact_add)
      });

      var file = argv.o || argv.f
      if ( !argv.save && adds.length > 0 ) {
        prompt.get({
          properties: {
            'save': {
              description: "Save "+adds.length+" transactions to ledger?",
              pattern: ynpatt,
              message: 'y(es)/n(o)',
              required: true
            }
          }
        }, function( err, result ) {
          if ( result.save.match(/^y/i) ) {
            // save it
            savexact( adds, file )
          }
        })
      } else {
        savexact( adds, file )
      }

      cb(null)

    })
  }
], function(err, result) {
  if ( err ) throw err
  console.log(JSON.stringify(result));
})
