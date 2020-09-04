class ArduinoCli {
    constructor(asyncExecFile, os, path, app) {
        this.asyncExecFile = asyncExecFile;
        this.arduinoCliPath = this.getArduinoCliPath(os, path, app);
    }

    getArduinoCliPath = (os, path, app) => {
        let platformFolder;
        let arduino_cli;    
        const platform = os.platform;
        if (platform == "win32") {
            platformFolder = "win32";
            arduino_cli = "arduino-cli.exe";
        } else if (platform == "darwin") {
            platformFolder = "darwin";
            arduino_cli = "arduino-cli";
        }
        const arduinoCliPath = path.join(app.getAppPath(), 'lib', platformFolder, 'arduino_cli', arduino_cli);
        return arduinoCliPath;
    }

    run = async (params) => {
        try {
            const { stdout, stderr } = await this.asyncExecFile(this.arduinoCliPath, params);
            if (stderr) {
                console.log('stderr:', stderr);
            }
            return stdout;
        } catch (e) {
            console.error(e);
            throw (e);
        }
    }
}

module.exports = ArduinoCli;