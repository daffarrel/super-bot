import Middleware from './Middleware'
import Message from './Message'
import MessageBuilder from './MessageBuilder'
import SuperBotProxy from './SuperBotProxy'

function parse(str) {
    let pos = str.indexOf(' ');
    return (pos === -1) ? [str, ''] : [str.substr(0, pos), str.substr(pos + 1)];
};

function join(str1, str2, delim) {
    if (str1.length == 0) {
        return str2;
    }
    else if (str2.length == 0) {
        return str1;
    }
    else {
        return str1 + delim + str2;
    }
}

async function loadPlugin(bot, path, file) {
    try {
        const pluginPath = require('path').join(path, file);
        const mod = await import(pluginPath);
        
        console.log(`Initializing plugin: ${file}...`);
        
        mod.default(bot);
        
        console.log(`Done plugin: ${file}.`);
    }
    catch(err) {
        console.error(err);
    }
}

async function loadAllPlugins(bot, path) {
    console.log(`Loading all plugins from path: ${path}`);
    for (const file of require('fs').readdirSync(path)) {
        console.log(`Loading plugin: ${file}...`);        
        await loadPlugin(bot, path, file);
    }
}

async function loadPlugins(bot, path, plugins) {
    console.log(`Loading plugins from path: ${path}`);
    if (plugins) {
        for (let plugin of plugins) {
            if (plugin.disabled) continue;
            
            console.log(`Loading plugin: ${plugin.name}.js...`);
            await loadPlugin(bot, path, `${plugin.name}.js`);
        }
    }
    else {
        await loadAllPlugins(bot, path);
    }
}

String.prototype.format = String.prototype.format ||
function () {
    "use strict";
    var str = this.toString();
    if (arguments.length) {
        var t = typeof arguments[0];
        var key;
        var args = ("string" === t || "number" === t) ?
            Array.prototype.slice.call(arguments)
            : arguments[0];

        for (key in args) {
            str = str.replace(new RegExp("\\{" + key + "\\}", "gi"), args[key]);
        }
    }

    return str;
};

export default class SuperBot {
    constructor(options) {
        this.options = options;
        this.commands = {};
        this.middleware = new Middleware();
        this.rawMiddleware = new Middleware();
    }

    async start() {
        if (this._started) return;
        this._started = true;

        this.command('all', (bot, message) => {
            bot.respond(Object.getOwnPropertyNames(this.commands).join(', '));
        });

        if (this.options.pluginsPath) {
            await loadPlugins(
                this, 
                require('path').join(__dirname, '../../', this.options.pluginsPath), 
                this.options.plugins);
        }
    }

    use(fn) {
        this.middleware.use(fn);
        return this;
    }

    command(command, handler) {
        command = command.toLowerCase();
        if (this.commands[command]) {
            throw new Error(`Command already registered: ${command}`);
        }
        this.commands[command] = handler;
    }

    raw(handler) {
        this.rawMiddleware.use(handler);
    }

    _normalizeIncoming(message) {
        if (message.attachment && (!message.attachments || message.attachments.length == 0)) {
            message.attachments = [message.attachment];
        }
        else if (!message.attachment && message.attachments && message.attachments.length > 0) {
            message.attachment = message.attachments[0];
        }
        return message;
    }

    _normalizeOutgoing(message) {
        if (message.attachment) {
            if (!message.attachments || message.attachments.length == 0) {
                message.attachments = [message.attachment];
            }
            message.attachment = undefined;
        }
        return message;
    }

    _handleMessage(message) {
        this._normalizeIncoming(message);

        return new Promise((resolve, reject) => {
            try {
                const respondHandler = (message) => {
                    resolve(message);
                };
                this.middleware.go(new SuperBotProxy(this, message, respondHandler), message, (b, message) => {
                    let parsedText = parse(message.text);
                    let bot = new SuperBotProxy(this, message, respondHandler);
                
                    let first = parsedText[0].toLowerCase();
                    if (first.length === 0) {
                        bot.error('I don\'t understand that.');
                        return;
                    }

                    try {
                        if (this.commands[first]) {
                            let command = first;
                            message.command = command;
                            message.fullText = message.text;
                            message.text = parsedText[1];

                            this.commands[first](bot, message);
                        }
                        else {
                            this.rawMiddleware.go(bot, message, (b, message) => {
                                bot.error(`I don't recognize "${first}".`);
                            });
                        }
                    }
                    catch (err) {
                        console.log(err);
                        reject('Something went wrong.');
                    }
                });
            }
            catch (err) {
                console.log(err);
                reject('Something went wrong.');
            }
        });
    }

    async receiveInternal(message) {
        if (this.options.enablePipe) {
            const pipeline = message.text.split(` ${this.options.pipeDelimeter || '|'} `);
            if (pipeline.length > 1) {
                message.text = pipeline[0];
            }
            for (let i = 0; i < pipeline.length; ++i) {
                const result = await this._handleMessage(message);

                if (i === pipeline.length - 1) {
                    return result;
                }
                else {
                    message.text = join(pipeline[i + 1], result.text || "", " ");
                    message.attachment = result.attachment;
                    message.attachments = result.attachments;
                }
            }
        }
        else {
            return await this._handleMessage(message);
        }
    }

    async receive(message) {
        const response = await this.receiveInternal(message);
        return this._normalizeOutgoing(response);
    }
}