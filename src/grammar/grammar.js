/**
 * The MIT License (MIT)
 * Copyright (c) 2015-present Dmitry Soshnikov <dmitry.soshnikov@gmail.com>
 */

import BnfParser from '../generated/bnf-parser.gen';
import GrammarMode from './grammar-mode';
import GrammarSymbol from './grammar-symbol';
import LexGrammar from './lex-grammar';
import LexRule from './lex-rule';
import Production from './production';

import colors from 'colors';
import fs from 'fs';
import vm from 'vm';

/**
 * Class encapsulates operations with a grammar.
 */
export default class Grammar {

  /**
   * A grammar may be passed as an object with `lex` and `bnf` properties.
   * The `lex` part is a set of rules for the lexer, and `bnf` is actual
   * context-free grammar. If `start` property is passed, it's used as the
   * start symbol, otherwise it's inferred from the first production.
   *
   * const grammar = {
   *
   *   // Lexical grammar
   *   // format: <regexp rule>: token
   *   // The token can either be a raw string value, like "foo",
   *   // or a variable (written in ALL_CAPITALIZED notation), which
   *   // can be used further in the `bnf` grammar.
   *
   *   "lex": {
   *     "macros": {
   *       "digit": "[0-9]",
   *     },
   *
   *     "rules": [
   *       ["a", "return 'a';"],
   *       ["\\(", "return '(';"],
   *       ["\\)", "return ')';"],
   *       ["\\+", "return '+';"],
   *       ["{digit}+(\\.{digit}+)?\\b", "return 'NUMBER';"],
   *
   *       // A rule with start conditions. Such rules are matched only
   *       // when a scanner enters these states.
   *       [["string", "code"], '[^"]',  "return 'STRING';"],
   *     ],
   *
   *     "startConditions": { https://gist.github.com/DmitrySoshnikov/f5e2583b37e8f758c789cea9dcdf238a
   *       "string": 1, // inclusive condition %s
   *       "code": 0,   // exclusive consition %x
   *     },
   *   },
   *
   *   // Arbitrary code to be included in the generated parser.
   *
   *   "moduleInclude": "const AST = require('./ast');"
   *
   *   "tokens": "a ( ) + NUMBER",
   *
   *   "start": "S",
   *
   *   // BNF grammar
   *
   *   bnf: {
   *     "S": [ "F",
   *            "( S + F )" ],
   *     "F": [ "a",
   *            "NUMBER" ],
   *   }
   * };
   *
   * Note: the "bnf" can also be passed as a string:
   *
   *   bnf: `
   *     S -> F
   *        | ( S + F )
   *
   *     F -> a
   *        | NUMBER
   *   `
   *
   * Note: if no `lex` is provided, the lexical grammar is inferred
   * from the list of all terminals in the `bnf` grammar.
   */
  constructor({
    /**
     * Lexical grammar.
     */
    lex,

    /**
     * Explicit list of tokens. If not provided, it's inferred automatically
     * from the BNF grammar.
     */
    tokens,

    /**
     * BNF grammar.
     */
    bnf,

    /**
     * Precedence, and associativity.
     */
    operators,

    /**
     * Start symbol. If not provided, it's inferred from the first
     * production's LHS.
     */
    start,

    /**
     * Grammar mode (LL1, SLR1, LALR1, etc).
     */
    mode,

    /**
     * Source code which should be included at the beginning of
     * the generated parser.
     */
    moduleInclude = '',

    /**
     * Whether to capture locations.
     */
    captureLocations = false,
  }) {
    this._mode = new GrammarMode(mode);
    this._startSymbol = start;

    this._captureLocations = captureLocations;

    // Operators and precedence.
    this._operators = this._processOperators(operators);

    // Actual BNF grammar.
    this._originalBnf = bnf;
    this._bnf = this._processBnf(this._originalBnf);

    // Injecting user code, including handlers for `yyparse.onParseBegin`,
    // and `yyparse.onParseEnd`.
    this._moduleInclude = moduleInclude;

    this._nonTerminals = this.getNonTerminals();
    this._terminals = this.getTerminals();

    if (typeof tokens === 'string') {
      tokens = tokens.split(/\s+/);
    }

    this._tokens = Array.isArray(tokens)
      ? tokens.map(token => GrammarSymbol.get(token))
      : this.getTokens();

    // Lexical grammar.
    this._lexGrammar = this._createLexGrammar(lex);
    this._tokens = this._processTokens(tokens);

    // Caching maps.
    this._productionsForSymbol = {};
    this._productionsWithSymbol = {};
  }

  /**
   * Loads a grammar object from a grammar file,
   * for the specific options.
   */
  static fromGrammarFile(grammarFile, options = {}, grammarType = 'bnf') {
    const grammarData = Grammar.dataFromGrammarFile(grammarFile, grammarType);
    return Grammar.fromData(grammarData, options);
  }

  /**
   * Reads grammar file data. Supports reading `bnf`,
   * and `lex` grammars based on mode.
   */
  static dataFromGrammarFile(grammarFile, grammarType = 'bnf') {
    return Grammar.dataFromString(fs.readFileSync(grammarFile, 'utf-8'));
  }

  /**
   * Creates Grammar instance from grammar data for
   * a particular parsing options.
   */
  static fromData(grammarData, options = {}) {
    return new Grammar({...grammarData, ...options});
  }

  /**
   * Creates Grammar instance from grammar string.
   */
  static fromString(string, options = {}, grammarType = 'bnf') {
    const grammarData = Grammar.dataFromString(string, grammarType);
    return Grammar.fromData(grammarData, options);
  }

  /**
   * Generates data from grammar string.
   */
  static dataFromString(grammarString, grammarType = 'bnf') {
    let grammarData = null;

    try {
      // Pure JSON representation.
      grammarData = JSON.parse(grammarString);
    } catch (e) {
      // JS code.
      try {
        grammarData = vm.runInNewContext(`
          (function() { return (${grammarString});})()
        `);
      } catch (jsEx) {
        const jsError = jsEx.stack;
        // A grammar as a string, for BNF, and lex.
        if (grammarType) {
          try {
            grammarData = BnfParser.parse(grammarString);
          } catch (bnfEx) {
            console.error(
              colors.red('\nParsing grammar in JS-format failed:\n\n') +
              jsError +'\n',
            );
            console.error(
              colors.red('\nParsing grammar in BNF-format failed:\n\n'),
            );
            throw bnfEx;
          }
        }
      }
    }

    return grammarData;
  }

  /**
   * Returns associated lexical grammar.
   */
  getLexGrammar() {
    return this._lexGrammar;
  }

  /**
   * Returns Start symbol of this grammar (it's initialized
   * during normalization process).
   */
  getStartSymbol() {
    return this._startSymbol;
  }

  /**
   * Returns grammar mode.
   */
  getMode() {
    return this._mode;
  }

  /**
   * Returns module include code.
   */
  getModuleInclude() {
    return this._moduleInclude;
  }

  /**
   * Whther should capture locations.
   */
  shouldCaptureLocations() {
    return this._captureLocations;
  }

  /**
   * Returns precedence and associativity of operators.
   */
  getOperators() {
    return this._operators;
  }

  /**
   * Returns list of terminals in this grammar.
   */
  getTerminals() {
    if (!this._terminals) {
      this._terminals = [];

      let terminals = {};

      this._bnf.forEach(production => {
        production.getRHS().forEach(symbol => {
          if (symbol.isTerminal() &&
              !terminals.hasOwnProperty(symbol.getSymbol())) {
            terminals[symbol.getSymbol()] = true;
            this._terminals.push(symbol);
          }
        });
      });
    }

    return this._terminals;
  }

  /**
   * Returns terminal symbols.
   */
  getTerminalSymbols() {
    if (!this._terminalSymbols) {
      this._terminalSymbols = this.getTerminals()
        .map(symbol => symbol.getSymbol());
    }
    return this._terminalSymbols;
  }

  /**
   * Returns list of non-terminals in this grammar.
   */
  getNonTerminals() {
    if (!this._nonTerminals) {
      this._nonTerminals = [];

      this._nonTerminalsMap = {};

      this._bnf.forEach(production => {
        if (production.isAugmented()) {
          return;
        }
        let nonTerminal = production.getLHS();
        if (!this._nonTerminalsMap.hasOwnProperty(nonTerminal.getSymbol())) {
          this._nonTerminalsMap[nonTerminal.getSymbol()] = true;
          this._nonTerminals.push(nonTerminal);
        }
      });
    }

    return this._nonTerminals;
  }

  /**
   * Returns list of non-terminal symbols.
   */
  getNonTerminalSymbols() {
    if (!this._nonTerminalSymbols) {
      this._nonTerminalSymbols = this.getNonTerminals()
        .map(symbol => symbol.getSymbol());
    }
    return this._nonTerminalSymbols;
  }

  /**
   * Returns tokens. Infer tokens from the grammar if
   * they were not passed explicitly.
   */
  getTokens() {
    if (!this._tokens) {
      this._tokens = [];

      let tokensMap = {};

      this._bnf.forEach(production => {
        if (production.isAugmented() || production.isEpsilon()) {
          return;
        }
        production.getRHS().forEach(symbol => {
          let rawSymbol = symbol.getSymbol();
          if (!symbol.isTerminal() &&
              !this._nonTerminalsMap.hasOwnProperty(rawSymbol) &&
              !tokensMap.hasOwnProperty(rawSymbol)) {
            tokensMap[rawSymbol] = true;
            this._tokens.push(symbol);
          }
        });
      });
    }

    return this._tokens;
  }

  /**
   * Returns token symbols.
   */
  getTokenSymbols() {
    if (!this._tokenSymbols) {
      this._tokenSymbols = this.getTokens()
        .map(symbol => symbol.getSymbol());
    }
    return this._tokenSymbols;
  }

  /**
   * Returns grammar productions.
   */
  getProductions() {
    return this._bnf;
  }

  /**
   * Returns productions for a specific non-terminal.
   */
  getProductionsForSymbol(symbol) {
    if (symbol instanceof GrammarSymbol) {
      symbol = symbol.getSymbol();
    }

    if (!this._productionsForSymbol.hasOwnProperty(symbol)) {
      this._productionsForSymbol[symbol] = this._bnf.filter(production => {
        return production.getLHS().isSymbol(symbol);
      });
    }

    return this._productionsForSymbol[symbol];
  }

  /**
   * Returns productions where a non-terminal is used (appears on RHS).
   */
  getProductionsWithSymbol(symbol) {
    if (symbol instanceof GrammarSymbol) {
      symbol = symbol.getSymbol();
    }

    if (!this._productionsWithSymbol.hasOwnProperty(symbol)) {
      this._productionsWithSymbol[symbol] = this._bnf.filter(production => {
        return production.getRHS().some(s => s.getSymbol() === symbol);
      });
    }

    return this._productionsWithSymbol[symbol];
  }

  /**
   * Gets a production by number.
   */
  getProduction(number) {
    // LL grammars do not have augmented 0-production.
    return this._bnf[this._mode.isLL() ? number - 1 : number];
  }

  /**
   * Returns an augmented production (used in LR parsers),
   * which is built during normalization process. The augmented
   * production is always the first one.
   */
  getAugmentedProduction() {
    if (!this._mode.isLR()) {
      throw new TypeError(
        `Augmented production is built only for LR grammars`
      );
    }
    return this._bnf[0];
  }

  /**
   * Tokens are either raw text values like "foo", or
   * one of the variables from the lexical grammar.
   */
  isTokenSymbol(symbol) {
    if (!(symbol instanceof GrammarSymbol)) {
      symbol = GrammarSymbol.get(symbol);
    }

    return symbol.isTerminal() ||
      this.getTokens().some(token => {
        return token.getSymbol() === symbol.getSymbol();
      });
  }

  /**
   * Pretty prints the grammar.
   */
  print() {
    console.info('\nGrammar:\n');

    let pad = '    ';
    let productions = this.getProductions();
    let numberPad = productions.length.toString().length;

    productions.forEach(production => {
      let productionOutput =
        `${pad}${this._padLeft(production.getNumber(), numberPad)}. ` +
        production.toString();

      console.info(productionOutput);

      if (this._mode.isLR() && production.isAugmented()) {
        let splitter = Array(productionOutput.length - 2).join('-');
        console.info(`${pad}${splitter}`);
      }
    });
  }

  _padLeft(value, times) {
    value = value.toString();
    let spaces = Array(times - value.length + 1).join(' ');
    return spaces + value;
  }

  _processOperators(operators) {
    let processedOperators = {};

    if (operators) {
      operators.forEach((opData, i) => {
        opData.slice(1).forEach(op => {
          processedOperators[op] = {
            precedence: i + 1,
            assoc: opData[0],
          };
        })
      });
    }

    return processedOperators;
  }

  /**
   * Generates data arrays for lex rules inferred from terminals.
   */
  _generateLexRulesDataForTerminals() {
    return this.getTerminals().map(terminal => [
      LexRule.matcherFromTerminal(terminal.getSymbol()), // matcher
      `return ${terminal.quotedTerminal()};`, // token handler
    ]);
  }

  /**
   * Creates lex grammar instance.
   */
  _createLexGrammar(lex) {
    if (!lex) {
      lex = {
        rules: [],
      };
    }

    // Infer automatic lex-rules from raw terminals
    // (symbols in quotes) in BNF productions RHS.
    lex.rules.push(...this._generateLexRulesDataForTerminals());

    return new LexGrammar(lex);
  }

  /**
   * Processes tokens.
   */
  _processTokens(tokens) {
    if (typeof tokens === 'string') {
      tokens = tokens.split(/\s+/);
    }

    return Array.isArray(tokens)
      ? tokens.map(token => GrammarSymbol.get(token))
      : this.getTokens();
  }

  _processBnf(originalBnf) {
    let processedBnf = [];
    let nonTerminals = Object.keys(originalBnf);

    // LR grammar uses augmented 0-production.
    let number = this._mode.isLR() ? 0 : 1;

    if (!this._startSymbol) {
      this._startSymbol = nonTerminals[0];
    }

    if (this._mode.isLR()) {
      // Augmented rule, $accept -> S.
      let augmentedProduction = new Production({
        LHS: '$accept',
        RHS: this._startSymbol,
        number: number++,
        grammar: this,
      });
      processedBnf[0] = augmentedProduction;
    }

    nonTerminals.forEach(LHS => {
      originalBnf[LHS].forEach((RHS, k) => {
        let semanticAction = null;
        let precedence = null;

        if (Array.isArray(RHS)) {
          let precedenceTag = null;

          if (typeof RHS[1] === 'string') {
            semanticAction = RHS[1];
            if (RHS[2] !== null && typeof RHS[2] === 'object') {
              precedenceTag = RHS[2].prec;
            }
          } else if (RHS[1] !== null && typeof RHS[1] === 'object') {
            precedenceTag = RHS[1].prec;
          }

          RHS = RHS[0];

          if (precedenceTag && this._operators) {
            precedence = this._operators[precedenceTag].precedence;
          }
        }

        processedBnf.push(new Production({
          LHS,
          RHS,
          semanticAction,
          precedence,
          number: number++,
          isShort: k > 0,
          grammar: this,
        }));
      });
    });

    return processedBnf;
  }
};
