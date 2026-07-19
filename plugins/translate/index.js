(function () {
'use strict';
function asyncGeneratorStep$3(gen, resolve, reject, _next, _throw, key, arg) {
    try {
        var info = gen[key](arg);
        var value = info.value;
    } catch (error) {
        reject(error);
        return;
    }
    if (info.done) resolve(value);
    else Promise.resolve(value).then(_next, _throw);
}
function _async_to_generator$3(fn) {
    return function() {
        var self = this, args = arguments;
        return new Promise(function(resolve, reject) {
            var gen = fn.apply(self, args);
            function _next(value) {
                asyncGeneratorStep$3(gen, resolve, reject, _next, _throw, "next", value);
            }
            function _throw(err) {
                asyncGeneratorStep$3(gen, resolve, reject, _next, _throw, "throw", err);
            }
            _next(undefined);
        });
    };
}
function _ts_generator$3(thisArg, body) {
    var f, y, t, _ = {
        label: 0,
        sent: function() {
            if (t[0] & 1) throw t[1];
            return t[1];
        },
        trys: [],
        ops: []
    }, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype), d = Object.defineProperty;
    return d(g, "next", {
        value: verb(0)
    }), d(g, "throw", {
        value: verb(1)
    }), d(g, "return", {
        value: verb(2)
    }), typeof Symbol === "function" && d(g, Symbol.iterator, {
        value: function() {
            return this;
        }
    }), g;
    function verb(n) {
        return function(v) {
            return step([
                n,
                v
            ]);
        };
    }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while(g && (g = 0, op[0] && (_ = 0)), _)try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [
                op[0] & 2,
                t.value
            ];
            switch(op[0]){
                case 0:
                case 1:
                    t = op;
                    break;
                case 4:
                    _.label++;
                    return {
                        value: op[1],
                        done: false
                    };
                case 5:
                    _.label++;
                    y = op[1];
                    op = [
                        0
                    ];
                    continue;
                case 7:
                    op = _.ops.pop();
                    _.trys.pop();
                    continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                        _ = 0;
                        continue;
                    }
                    if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                        _.label = op[1];
                        break;
                    }
                    if (op[0] === 6 && _.label < t[1]) {
                        _.label = t[1];
                        t = op;
                        break;
                    }
                    if (t && _.label < t[2]) {
                        _.label = t[2];
                        _.ops.push(op);
                        break;
                    }
                    if (t[2]) _.ops.pop();
                    _.trys.pop();
                    continue;
            }
            op = body.call(thisArg, _);
        } catch (e) {
            op = [
                6,
                e
            ];
            y = 0;
        } finally{
            f = t = 0;
        }
        if (op[0] & 5) throw op[1];
        return {
            value: op[0] ? op[1] : void 0,
            done: true
        };
    }
}
function _type_of$1(obj) {
    "@swc/helpers - typeof";
    return obj && typeof Symbol !== "undefined" && obj.constructor === Symbol ? "symbol" : typeof obj;
}
var PATCHER_ID = 'unbound.translate';
var DEFAULT_API_BASE_URL = 'https://translate.unbound.rip';
var DEFAULT_TARGET_LANGUAGE = 'en';
var DEFAULT_SOURCE_LANGUAGE = 'auto';
var STORE$1 = window.unbound.storage.getStore(PATCHER_ID);
var TOKEN_SKEW_MS = 15000;
var LANGUAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
var cachedLanguages = null;
var cachedLanguagesAt = 0;
var pendingLanguages = null;
function getApiBaseUrl() {
    return STORE$1.get('apiBaseUrl', DEFAULT_API_BASE_URL);
}
function readTokens() {
    var accessToken = STORE$1.get('accessToken', '');
    var refreshToken = STORE$1.get('refreshToken', '');
    var expiresAt = STORE$1.get('expiresAt', 0);
    if (!accessToken || !refreshToken || !expiresAt) return null;
    return {
        accessToken: accessToken,
        refreshToken: refreshToken,
        expiresAt: expiresAt
    };
}
function writeTokens(tokens) {
    STORE$1.set('accessToken', tokens.accessToken);
    STORE$1.set('refreshToken', tokens.refreshToken);
    STORE$1.set('expiresAt', tokens.expiresAt);
}
function clearTokens() {
    STORE$1.remove('accessToken');
    STORE$1.remove('refreshToken');
    STORE$1.remove('expiresAt');
}
function getSourceLanguage() {
    return STORE$1.get('sourceLanguage', DEFAULT_SOURCE_LANGUAGE);
}
function getTargetLanguage() {
    return STORE$1.get('targetLanguage', DEFAULT_TARGET_LANGUAGE);
}
function setSourceLanguage(code) {
    STORE$1.set('sourceLanguage', code);
}
function setTargetLanguage(code) {
    STORE$1.set('targetLanguage', code);
}
function getApiBaseUrlSetting() {
    return STORE$1.get('apiBaseUrl', DEFAULT_API_BASE_URL);
}
function setApiBaseUrl(url) {
    STORE$1.set('apiBaseUrl', url.trim() || DEFAULT_API_BASE_URL);
}
function refreshSessionTokens() {
    return _async_to_generator$3(function() {
        var refreshToken, response, reason, data, next;
        return _ts_generator$3(this, function(_state) {
            switch(_state.label){
                case 0:
                    refreshToken = STORE$1.get('refreshToken', '');
                    if (!refreshToken) {
                        throw new Error('No refresh token configured. Open plugin settings and complete login.');
                    }
                    return [
                        4,
                        fetch("".concat(getApiBaseUrl(), "/auth/refresh"), {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                refreshToken: refreshToken
                            })
                        })
                    ];
                case 1:
                    response = _state.sent();
                    if (!!response.ok) return [
                        3,
                        3
                    ];
                    if (response.status === 401) clearTokens();
                    return [
                        4,
                        response.text().catch(function() {
                            return 'refresh failed';
                        })
                    ];
                case 2:
                    reason = _state.sent();
                    throw new Error("Auth refresh failed (".concat(response.status, "): ").concat(reason));
                case 3:
                    return [
                        4,
                        response.json()
                    ];
                case 4:
                    data = _state.sent();
                    if (!data.accessToken || !data.refreshToken || typeof data.expiresIn !== 'number') {
                        throw new Error('Auth refresh returned an invalid payload.');
                    }
                    next = {
                        accessToken: data.accessToken,
                        refreshToken: data.refreshToken,
                        expiresAt: Date.now() + data.expiresIn * 1000
                    };
                    writeTokens(next);
                    return [
                        2,
                        next
                    ];
            }
        });
    })();
}
function getValidAccessToken() {
    return _async_to_generator$3(function() {
        var current, refreshed;
        return _ts_generator$3(this, function(_state) {
            switch(_state.label){
                case 0:
                    current = readTokens();
                    if (current && current.expiresAt - TOKEN_SKEW_MS > Date.now()) {
                        return [
                            2,
                            current.accessToken
                        ];
                    }
                    return [
                        4,
                        refreshSessionTokens()
                    ];
                case 1:
                    refreshed = _state.sent();
                    return [
                        2,
                        refreshed.accessToken
                    ];
            }
        });
    })();
}
function listLanguages() {
    var force = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : false;
    return _async_to_generator$3(function() {
        var isFresh;
        return _ts_generator$3(this, function(_state) {
            isFresh = cachedLanguages && Date.now() - cachedLanguagesAt < LANGUAGE_CACHE_TTL_MS;
            if (!force && isFresh && cachedLanguages) return [
                2,
                cachedLanguages
            ];
            if (pendingLanguages) return [
                2,
                pendingLanguages
            ];
            pendingLanguages = (function() {
                return _async_to_generator$3(function() {
                    var response, reason, data, languages;
                    return _ts_generator$3(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                return [
                                    4,
                                    fetch("".concat(getApiBaseUrl(), "/languages"))
                                ];
                            case 1:
                                response = _state.sent();
                                if (!!response.ok) return [
                                    3,
                                    3
                                ];
                                return [
                                    4,
                                    response.text().catch(function() {
                                        return 'failed to load languages';
                                    })
                                ];
                            case 2:
                                reason = _state.sent();
                                throw new Error("Language lookup failed (".concat(response.status, "): ").concat(reason));
                            case 3:
                                return [
                                    4,
                                    response.json()
                                ];
                            case 4:
                                data = _state.sent();
                                if (!Array.isArray(data)) {
                                    throw new Error('Language lookup returned an invalid payload.');
                                }
                                languages = data.map(function(entry) {
                                    if (!entry || (typeof entry === "undefined" ? "undefined" : _type_of$1(entry)) !== 'object') return null;
                                    var code = entry.code;
                                    var name = entry.name;
                                    var nativeName = entry.nativeName;
                                    if (typeof code !== 'string' || typeof name !== 'string') return null;
                                    return {
                                        code: code,
                                        name: name,
                                        nativeName: typeof nativeName === 'string' ? nativeName : undefined
                                    };
                                }).filter(function(entry) {
                                    return entry !== null;
                                }).sort(function(left, right) {
                                    return left.name.localeCompare(right.name);
                                });
                                cachedLanguages = languages;
                                cachedLanguagesAt = Date.now();
                                return [
                                    2,
                                    languages
                                ];
                        }
                    });
                })();
            })().finally(function() {
                pendingLanguages = null;
            });
            return [
                2,
                pendingLanguages
            ];
        });
    })();
}
function translateText(text) {
    return _async_to_generator$3(function() {
        var requestBody, requestOnce, token, response, reason, data, first;
        return _ts_generator$3(this, function(_state) {
            switch(_state.label){
                case 0:
                    if (!text.trim()) {
                        throw new Error('Message is empty.');
                    }
                    requestBody = {
                        q: text,
                        source: getSourceLanguage(),
                        target: getTargetLanguage()
                    };
                    requestOnce = function requestOnce(token) {
                        return _async_to_generator$3(function() {
                            return _ts_generator$3(this, function(_state) {
                                return [
                                    2,
                                    fetch("".concat(getApiBaseUrl(), "/translate"), {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            Authorization: "Bearer ".concat(token)
                                        },
                                        body: JSON.stringify(requestBody)
                                    })
                                ];
                            });
                        })();
                    };
                    return [
                        4,
                        getValidAccessToken()
                    ];
                case 1:
                    token = _state.sent();
                    return [
                        4,
                        requestOnce(token)
                    ];
                case 2:
                    response = _state.sent();
                    if (!(response.status === 401)) return [
                        3,
                        5
                    ];
                    return [
                        4,
                        refreshSessionTokens()
                    ];
                case 3:
                    token = _state.sent().accessToken;
                    return [
                        4,
                        requestOnce(token)
                    ];
                case 4:
                    response = _state.sent();
                    _state.label = 5;
                case 5:
                    if (!!response.ok) return [
                        3,
                        7
                    ];
                    return [
                        4,
                        response.text().catch(function() {
                            return 'translation failed';
                        })
                    ];
                case 6:
                    reason = _state.sent();
                    throw new Error("Translate failed (".concat(response.status, "): ").concat(reason));
                case 7:
                    return [
                        4,
                        response.json()
                    ];
                case 8:
                    data = _state.sent();
                    if ('translatedText' in data && typeof data.translatedText === 'string') {
                        return [
                            2,
                            data.translatedText
                        ];
                    }
                    if ('translations' in data && Array.isArray(data.translations) && data.translations.length > 0) {
                        first = data.translations[0];
                        if (typeof (first === null || first === void 0 ? void 0 : first.translatedText) === 'string') return [
                            2,
                            first.translatedText
                        ];
                        if (typeof (first === null || first === void 0 ? void 0 : first.text) === 'string') return [
                            2,
                            first.text
                        ];
                    }
                    throw new Error('Translation API returned an unexpected payload.');
            }
        });
    })();
}function asyncGeneratorStep$2(gen, resolve, reject, _next, _throw, key, arg) {
    try {
        var info = gen[key](arg);
        var value = info.value;
    } catch (error) {
        reject(error);
        return;
    }
    if (info.done) resolve(value);
    else Promise.resolve(value).then(_next, _throw);
}
function _async_to_generator$2(fn) {
    return function() {
        var self = this, args = arguments;
        return new Promise(function(resolve, reject) {
            var gen = fn.apply(self, args);
            function _next(value) {
                asyncGeneratorStep$2(gen, resolve, reject, _next, _throw, "next", value);
            }
            function _throw(err) {
                asyncGeneratorStep$2(gen, resolve, reject, _next, _throw, "throw", err);
            }
            _next(undefined);
        });
    };
}
function _instanceof$1(left, right) {
    "@swc/helpers - instanceof";
    if (right != null && typeof Symbol !== "undefined" && right[Symbol.hasInstance]) {
        return !!right[Symbol.hasInstance](left);
    } else return left instanceof right;
}
function _ts_generator$2(thisArg, body) {
    var f, y, t, _ = {
        label: 0,
        sent: function() {
            if (t[0] & 1) throw t[1];
            return t[1];
        },
        trys: [],
        ops: []
    }, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype), d = Object.defineProperty;
    return d(g, "next", {
        value: verb(0)
    }), d(g, "throw", {
        value: verb(1)
    }), d(g, "return", {
        value: verb(2)
    }), typeof Symbol === "function" && d(g, Symbol.iterator, {
        value: function() {
            return this;
        }
    }), g;
    function verb(n) {
        return function(v) {
            return step([
                n,
                v
            ]);
        };
    }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while(g && (g = 0, op[0] && (_ = 0)), _)try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [
                op[0] & 2,
                t.value
            ];
            switch(op[0]){
                case 0:
                case 1:
                    t = op;
                    break;
                case 4:
                    _.label++;
                    return {
                        value: op[1],
                        done: false
                    };
                case 5:
                    _.label++;
                    y = op[1];
                    op = [
                        0
                    ];
                    continue;
                case 7:
                    op = _.ops.pop();
                    _.trys.pop();
                    continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                        _ = 0;
                        continue;
                    }
                    if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                        _.label = op[1];
                        break;
                    }
                    if (op[0] === 6 && _.label < t[1]) {
                        _.label = t[1];
                        t = op;
                        break;
                    }
                    if (t && _.label < t[2]) {
                        _.label = t[2];
                        _.ops.push(op);
                        break;
                    }
                    if (t[2]) _.ops.pop();
                    _.trys.pop();
                    continue;
            }
            op = body.call(thisArg, _);
        } catch (e) {
            op = [
                6,
                e
            ];
            y = 0;
        } finally{
            f = t = 0;
        }
        if (op[0] & 5) throw op[1];
        return {
            value: op[0] ? op[1] : void 0,
            done: true
        };
    }
}
function _type_of(obj) {
    "@swc/helpers - typeof";
    return obj && typeof Symbol !== "undefined" && obj.constructor === Symbol ? "symbol" : typeof obj;
}
var Patcher = window.unbound.patcher.createPatcher('unbound.translate');
function findMessageInTree(value) {
    var depth = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : 0;
    if (!value || (typeof value === "undefined" ? "undefined" : _type_of(value)) !== 'object' || depth > 6) return null;
    var candidate = value;
    if (typeof candidate.content === 'string' && (typeof candidate.id === 'string' || typeof candidate.channel_id === 'string')) {
        return candidate;
    }
    var _iteratorNormalCompletion = true, _didIteratorError = false, _iteratorError = undefined;
    try {
        for(var _iterator = Object.values(value)[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true){
            var nested = _step.value;
            var found = findMessageInTree(nested, depth + 1);
            if (found) return found;
        }
    } catch (err) {
        _didIteratorError = true;
        _iteratorError = err;
    } finally{
        try {
            if (!_iteratorNormalCompletion && _iterator.return != null) {
                _iterator.return();
            }
        } finally{
            if (_didIteratorError) {
                throw _iteratorError;
            }
        }
    }
    return null;
}
function showError(error) {
    window.unbound.toasts.showToast({
        title: 'Translate Error',
        content: _instanceof$1(error, Error) ? error.message : String(error)
    });
}
function translateMessage(message) {
    return _async_to_generator$2(function() {
        var content, translated;
        return _ts_generator$2(this, function(_state) {
            switch(_state.label){
                case 0:
                    content = typeof message.content === 'string' ? message.content : '';
                    if (!content.trim()) {
                        window.unbound.toasts.showToast({
                            title: 'Translate',
                            content: 'Message has no text to translate.'
                        });
                        return [
                            2
                        ];
                    }
                    return [
                        4,
                        translateText(content)
                    ];
                case 1:
                    translated = _state.sent();
                    return [
                        4,
                        window.unbound.metro.common.Clipboard.setString(translated)
                    ];
                case 2:
                    _state.sent();
                    window.unbound.toasts.showToast({
                        title: 'Translated',
                        content: translated
                    });
                    return [
                        2
                    ];
            }
        });
    })();
}
function startTranslateMenuPatch() {
    var Discord = window.unbound.metro.components.Discord;
    if (!Discord || typeof Discord.showSimpleActionSheet !== 'function') return;
    Patcher.before(Discord, 'showSimpleActionSheet', function(param) {
        var args = param.args;
        var first = args[0];
        var second = args[1];
        var options = first && (typeof first === "undefined" ? "undefined" : _type_of(first)) === 'object' && Array.isArray(first.options) ? first.options : Array.isArray(second) ? second : null;
        if (!options || options.length === 0) return;
        var alreadyAdded = options.some(function(option) {
            if (!option || (typeof option === "undefined" ? "undefined" : _type_of(option)) !== 'object') return false;
            var key = option.key;
            var id = option.id;
            return key === 'unbound-translate' || id === 'unbound-translate';
        });
        if (alreadyAdded) return;
        var copyIndex = options.findIndex(function(option) {
            if (!option || (typeof option === "undefined" ? "undefined" : _type_of(option)) !== 'object') return false;
            var label = option.label;
            var key = option.key;
            var id = option.id;
            if (key === 'copy-text' || id === 'copy-text') return true;
            return typeof label === 'string' && label.toLowerCase().includes('copy');
        });
        if (copyIndex < 0) return;
        var message = findMessageInTree(args);
        if (!message || typeof message.content !== 'string' || !message.content.trim()) return;
        var action = function action() {
            return _async_to_generator$2(function() {
                var error;
                return _ts_generator$2(this, function(_state) {
                    switch(_state.label){
                        case 0:
                            _state.trys.push([
                                0,
                                2,
                                ,
                                3
                            ]);
                            return [
                                4,
                                translateMessage(message)
                            ];
                        case 1:
                            _state.sent();
                            return [
                                3,
                                3
                            ];
                        case 2:
                            error = _state.sent();
                            showError(error);
                            return [
                                3,
                                3
                            ];
                        case 3:
                            return [
                                2
                            ];
                    }
                });
            })();
        };
        options.splice(copyIndex + 1, 0, {
            key: 'unbound-translate',
            id: 'unbound-translate',
            label: 'Translate',
            action: action,
            onPress: action
        });
    });
}
function stopTranslateMenuPatch() {
    Patcher.unpatchAll();
}function _array_like_to_array(arr, len) {
    if (len == null || len > arr.length) len = arr.length;
    for(var i = 0, arr2 = new Array(len); i < len; i++)arr2[i] = arr[i];
    return arr2;
}
function _array_with_holes(arr) {
    if (Array.isArray(arr)) return arr;
}
function _array_without_holes(arr) {
    if (Array.isArray(arr)) return _array_like_to_array(arr);
}
function asyncGeneratorStep$1(gen, resolve, reject, _next, _throw, key, arg) {
    try {
        var info = gen[key](arg);
        var value = info.value;
    } catch (error) {
        reject(error);
        return;
    }
    if (info.done) resolve(value);
    else Promise.resolve(value).then(_next, _throw);
}
function _async_to_generator$1(fn) {
    return function() {
        var self = this, args = arguments;
        return new Promise(function(resolve, reject) {
            var gen = fn.apply(self, args);
            function _next(value) {
                asyncGeneratorStep$1(gen, resolve, reject, _next, _throw, "next", value);
            }
            function _throw(err) {
                asyncGeneratorStep$1(gen, resolve, reject, _next, _throw, "throw", err);
            }
            _next(undefined);
        });
    };
}
function _instanceof(left, right) {
    "@swc/helpers - instanceof";
    if (right != null && typeof Symbol !== "undefined" && right[Symbol.hasInstance]) {
        return !!right[Symbol.hasInstance](left);
    } else return left instanceof right;
}
function _iterable_to_array(iter) {
    if (typeof Symbol !== "undefined" && iter[Symbol.iterator] != null || iter["@@iterator"] != null) {
        return Array.from(iter);
    }
}
function _iterable_to_array_limit(arr, i) {
    var _i = arr == null ? null : typeof Symbol !== "undefined" && arr[Symbol.iterator] || arr["@@iterator"];
    if (_i == null) return;
    var _arr = [];
    var _n = true;
    var _d = false;
    var _s, _e;
    try {
        for(_i = _i.call(arr); !(_n = (_s = _i.next()).done); _n = true){
            _arr.push(_s.value);
            if (i && _arr.length === i) break;
        }
    } catch (err) {
        _d = true;
        _e = err;
    } finally{
        try {
            if (!_n && _i["return"] != null) _i["return"]();
        } finally{
            if (_d) throw _e;
        }
    }
    return _arr;
}
function _non_iterable_rest() {
    throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _non_iterable_spread() {
    throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _sliced_to_array(arr, i) {
    return _array_with_holes(arr) || _iterable_to_array_limit(arr, i) || _unsupported_iterable_to_array(arr, i) || _non_iterable_rest();
}
function _to_consumable_array(arr) {
    return _array_without_holes(arr) || _iterable_to_array(arr) || _unsupported_iterable_to_array(arr) || _non_iterable_spread();
}
function _ts_generator$1(thisArg, body) {
    var f, y, t, _ = {
        label: 0,
        sent: function() {
            if (t[0] & 1) throw t[1];
            return t[1];
        },
        trys: [],
        ops: []
    }, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype), d = Object.defineProperty;
    return d(g, "next", {
        value: verb(0)
    }), d(g, "throw", {
        value: verb(1)
    }), d(g, "return", {
        value: verb(2)
    }), typeof Symbol === "function" && d(g, Symbol.iterator, {
        value: function() {
            return this;
        }
    }), g;
    function verb(n) {
        return function(v) {
            return step([
                n,
                v
            ]);
        };
    }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while(g && (g = 0, op[0] && (_ = 0)), _)try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [
                op[0] & 2,
                t.value
            ];
            switch(op[0]){
                case 0:
                case 1:
                    t = op;
                    break;
                case 4:
                    _.label++;
                    return {
                        value: op[1],
                        done: false
                    };
                case 5:
                    _.label++;
                    y = op[1];
                    op = [
                        0
                    ];
                    continue;
                case 7:
                    op = _.ops.pop();
                    _.trys.pop();
                    continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                        _ = 0;
                        continue;
                    }
                    if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                        _.label = op[1];
                        break;
                    }
                    if (op[0] === 6 && _.label < t[1]) {
                        _.label = t[1];
                        t = op;
                        break;
                    }
                    if (t && _.label < t[2]) {
                        _.label = t[2];
                        _.ops.push(op);
                        break;
                    }
                    if (t[2]) _.ops.pop();
                    _.trys.pop();
                    continue;
            }
            op = body.call(thisArg, _);
        } catch (e) {
            op = [
                6,
                e
            ];
            y = 0;
        } finally{
            f = t = 0;
        }
        if (op[0] & 5) throw op[1];
        return {
            value: op[0] ? op[1] : void 0,
            done: true
        };
    }
}
function _unsupported_iterable_to_array(o, minLen) {
    if (!o) return;
    if (typeof o === "string") return _array_like_to_array(o, minLen);
    var n = Object.prototype.toString.call(o).slice(8, -1);
    if (n === "Object" && o.constructor) n = o.constructor.name;
    if (n === "Map" || n === "Set") return Array.from(n);
    if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _array_like_to_array(o, minLen);
}
function languageLabel(language) {
    return language.nativeName && language.nativeName !== language.name ? "".concat(language.name, " (").concat(language.nativeName, ")") : language.name;
}
function LanguagePickerSheet(param) {
    var title = param.title, includeAuto = param.includeAuto, current = param.current, onSelect = param.onSelect, onClose = param.onClose;
    window.unbound.metro.common.ReactNative;
    var Discord = window.unbound.metro.components.Discord;
    var _useState = _sliced_to_array(window.React.useState(''), 2), query = _useState[0], setQuery = _useState[1];
    var _useState1 = _sliced_to_array(window.React.useState([]), 2), languages = _useState1[0], setLanguages = _useState1[1];
    var _useState2 = _sliced_to_array(window.React.useState(null), 2), error = _useState2[0], setError = _useState2[1];
    window.React.useEffect(function() {
        var cancelled = false;
        void function() {
            return _async_to_generator$1(function() {
                var loaded, err;
                return _ts_generator$1(this, function(_state) {
                    switch(_state.label){
                        case 0:
                            _state.trys.push([
                                0,
                                2,
                                ,
                                3
                            ]);
                            return [
                                4,
                                listLanguages()
                            ];
                        case 1:
                            loaded = _state.sent();
                            if (!cancelled) setLanguages(loaded);
                            return [
                                3,
                                3
                            ];
                        case 2:
                            err = _state.sent();
                            if (!cancelled) setError(_instanceof(err, Error) ? err.message : String(err));
                            return [
                                3,
                                3
                            ];
                        case 3:
                            return [
                                2
                            ];
                    }
                });
            })();
        }();
        return function() {
            cancelled = true;
        };
    }, []);
    var rows = window.React.useMemo(function() {
        var normalizedQuery = query.trim().toLowerCase();
        var matches = languages.filter(function(language) {
            var _language_nativeName;
            if (!normalizedQuery) return true;
            return language.code.toLowerCase().includes(normalizedQuery) || language.name.toLowerCase().includes(normalizedQuery) || ((_language_nativeName = language.nativeName) === null || _language_nativeName === void 0 ? void 0 : _language_nativeName.toLowerCase().includes(normalizedQuery));
        });
        return includeAuto ? [
            {
                code: 'auto',
                name: 'Auto detect'
            }
        ].concat(_to_consumable_array(matches)) : matches;
    }, [
        includeAuto,
        languages,
        query
    ]);
    function choose(code) {
        onSelect(code);
        onClose();
    }
    return /*#__PURE__*/ React.createElement(Discord.ActionSheet, null, /*#__PURE__*/ React.createElement(Discord.TextField, {
        size: "md",
        value: query,
        onChange: setQuery,
        isClearable: true,
        isRound: true,
        placeholder: title
    }), error ? /*#__PURE__*/ React.createElement(Discord.ActionSheetRow, {
        label: error,
        onPress: onClose
    }) : null, rows.map(function(language) {
        return /*#__PURE__*/ React.createElement(Discord.ActionSheetRow, {
            key: language.code,
            label: language.code === 'auto' ? 'Auto detect' : languageLabel(language),
            subLabel: language.code === current ? "".concat(language.code, " • current") : language.code,
            onPress: function onPress() {
                return choose(language.code);
            }
        });
    }), !error && rows.length === 0 ? /*#__PURE__*/ React.createElement(Discord.ActionSheetRow, {
        label: "No matches",
        onPress: onClose
    }) : null);
}function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
    try {
        var info = gen[key](arg);
        var value = info.value;
    } catch (error) {
        reject(error);
        return;
    }
    if (info.done) resolve(value);
    else Promise.resolve(value).then(_next, _throw);
}
function _async_to_generator(fn) {
    return function() {
        var self = this, args = arguments;
        return new Promise(function(resolve, reject) {
            var gen = fn.apply(self, args);
            function _next(value) {
                asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
            }
            function _throw(err) {
                asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
            }
            _next(undefined);
        });
    };
}
function _ts_generator(thisArg, body) {
    var f, y, t, _ = {
        label: 0,
        sent: function() {
            if (t[0] & 1) throw t[1];
            return t[1];
        },
        trys: [],
        ops: []
    }, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype), d = Object.defineProperty;
    return d(g, "next", {
        value: verb(0)
    }), d(g, "throw", {
        value: verb(1)
    }), d(g, "return", {
        value: verb(2)
    }), typeof Symbol === "function" && d(g, Symbol.iterator, {
        value: function() {
            return this;
        }
    }), g;
    function verb(n) {
        return function(v) {
            return step([
                n,
                v
            ]);
        };
    }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while(g && (g = 0, op[0] && (_ = 0)), _)try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [
                op[0] & 2,
                t.value
            ];
            switch(op[0]){
                case 0:
                case 1:
                    t = op;
                    break;
                case 4:
                    _.label++;
                    return {
                        value: op[1],
                        done: false
                    };
                case 5:
                    _.label++;
                    y = op[1];
                    op = [
                        0
                    ];
                    continue;
                case 7:
                    op = _.ops.pop();
                    _.trys.pop();
                    continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                        _ = 0;
                        continue;
                    }
                    if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                        _.label = op[1];
                        break;
                    }
                    if (op[0] === 6 && _.label < t[1]) {
                        _.label = t[1];
                        t = op;
                        break;
                    }
                    if (t && _.label < t[2]) {
                        _.label = t[2];
                        _.ops.push(op);
                        break;
                    }
                    if (t[2]) _.ops.pop();
                    _.trys.pop();
                    continue;
            }
            op = body.call(thisArg, _);
        } catch (e) {
            op = [
                6,
                e
            ];
            y = 0;
        } finally{
            f = t = 0;
        }
        if (op[0] & 5) throw op[1];
        return {
            value: op[0] ? op[1] : void 0,
            done: true
        };
    }
}
var SETTINGS_ROUTE = 'unbound.translate.settings';
var STORE = window.unbound.storage.getStore('unbound.translate');
function openLanguageSheet(options) {
    var sheets = window.unbound.metro.findByProps('openLazy', 'hideActionSheet');
    if (!sheets) {
        window.unbound.toasts.showToast({
            title: 'Translate',
            content: 'Language picker is unavailable.'
        });
        return;
    }
    var key = "unbound-translate-".concat(options.title, "-").concat(options.current);
    sheets.openLazy(Promise.resolve({
        default: LanguagePickerSheet
    }), key, {
        title: options.title,
        current: options.current,
        includeAuto: options.includeAuto,
        onSelect: options.onSelect,
        onClose: function onClose() {
            return sheets.hideActionSheet(key);
        }
    });
}
function pasteRefreshTokenFromClipboard() {
    return _async_to_generator(function() {
        var value;
        return _ts_generator(this, function(_state) {
            switch(_state.label){
                case 0:
                    return [
                        4,
                        window.unbound.metro.common.Clipboard.getString()
                    ];
                case 1:
                    value = _state.sent();
                    if (!value || !value.trim()) {
                        window.unbound.toasts.showToast({
                            title: 'Translate',
                            content: 'Clipboard does not contain a token.'
                        });
                        return [
                            2
                        ];
                    }
                    STORE.set('refreshToken', value.trim());
                    STORE.remove('accessToken');
                    STORE.remove('expiresAt');
                    window.unbound.toasts.showToast({
                        title: 'Translate',
                        content: 'Refresh token saved.'
                    });
                    return [
                        2
                    ];
            }
        });
    })();
}
function cycleTargetLanguage(current) {
    var _options_;
    var options = [
        'en',
        'es',
        'fr'
    ];
    var index = options.indexOf(current);
    return (_options_ = options[(index + 1) % options.length]) !== null && _options_ !== void 0 ? _options_ : 'en';
}
function cycleSourceLanguage(current) {
    return current === 'auto' ? 'en' : 'auto';
}
function TranslateSettingsScreen() {
    var ReactNative = window.unbound.metro.common.ReactNative;
    var Discord = window.unbound.metro.components.Discord;
    var state = STORE.useSettingsStore();
    var refreshConfigured = !!state.get('refreshToken', '');
    var targetLanguage = getTargetLanguage();
    var sourceLanguage = getSourceLanguage();
    var apiBaseUrl = getApiBaseUrlSetting();
    return /*#__PURE__*/ React.createElement(ReactNative.ScrollView, {
        contentContainerStyle: {
            padding: 16,
            gap: 12
        }
    }, /*#__PURE__*/ React.createElement(Discord.TableRowGroup, {
        title: "Translate API"
    }, /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Start Discord Login",
        subLabel: "".concat(apiBaseUrl, "/auth/login"),
        onPress: function onPress() {
            return window.unbound.metro.api.Linking.openURL("".concat(apiBaseUrl, "/auth/login"));
        }
    }), /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Paste Refresh Token",
        subLabel: refreshConfigured ? 'Configured. Tap to replace from clipboard.' : 'Tap to paste refresh token from clipboard.',
        onPress: function onPress() {
            void pasteRefreshTokenFromClipboard();
        }
    }), /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Clear Tokens",
        onPress: function onPress() {
            clearTokens();
            window.unbound.toasts.showToast({
                title: 'Translate',
                content: 'Tokens cleared.'
            });
        }
    }), /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "API Base URL",
        subLabel: apiBaseUrl,
        onPress: function onPress() {
            setApiBaseUrl(DEFAULT_API_BASE_URL);
            window.unbound.toasts.showToast({
                title: 'Translate',
                content: 'API base reset to default.'
            });
        }
    })), /*#__PURE__*/ React.createElement(Discord.TableRowGroup, {
        title: "Languages"
    }, /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Source Language",
        subLabel: sourceLanguage,
        arrow: true,
        onPress: function onPress() {
            return openLanguageSheet({
                title: 'Select source language',
                current: sourceLanguage,
                includeAuto: true,
                onSelect: setSourceLanguage
            });
        }
    }), /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Target Language",
        subLabel: targetLanguage,
        arrow: true,
        onPress: function onPress() {
            return openLanguageSheet({
                title: 'Select target language',
                current: targetLanguage,
                onSelect: setTargetLanguage
            });
        }
    }), /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Cycle Target",
        onPress: function onPress() {
            return setTargetLanguage(cycleTargetLanguage(targetLanguage));
        }
    }), /*#__PURE__*/ React.createElement(Discord.TableRow, {
        label: "Cycle Source",
        onPress: function onPress() {
            return setSourceLanguage(cycleSourceLanguage(sourceLanguage));
        }
    })));
}
function registerTranslateSettings() {
    window.unbound.settings.registerSettings({
        type: 'route',
        key: SETTINGS_ROUTE,
        useTitle: function useTitle() {
            return 'Translate';
        },
        parent: null,
        section: 'Plugins',
        screen: {
            route: SETTINGS_ROUTE,
            getComponent: function getComponent() {
                return TranslateSettingsScreen;
            }
        }
    });
}
function unregisterTranslateSettings() {
    window.unbound.settings.removeSettings(SETTINGS_ROUTE);
}var index = {
    start: function start() {
        startTranslateMenuPatch();
        registerTranslateSettings();
    },
    stop: function stop() {
        stopTranslateMenuPatch();
        unregisterTranslateSettings();
    }
};
return index;
})()