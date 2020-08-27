const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require("path");

if (handleSquirrelEvent()) {
    // squirrel event handled and app will exit in 1000ms, so don't do anything else
    return;
}
const url = require("url");
const fs = require('fs');
const os = require("os");
const util = require('util');
const runExecutableAsync = util.promisify(require('child_process').execFile);

let mainWindow;

function loadUrl(mainWindow) {
    mainWindow.loadURL(
        url.format({
            pathname: path.join(__dirname, "dist", "index.html"),
            protocol: "file:",
            slashes: true,
        })
    );
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true
        }
    })

    mainWindow.setMenu(null);
    mainWindow.setMenuBarVisibility(false);

    loadUrl(mainWindow);

    // Open the DevTools.
    //mainWindow.webContents.openDevTools()

    mainWindow.on('closed', function () {
        mainWindow = null
    })

    mainWindow.webContents.on('did-fail-load', function () {
        loadUrl(mainWindow);
    })
}

app.on('ready', createWindow)

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit()
})

app.on('activate', function () {
    if (mainWindow === null) createWindow()
})

app.setAppLogsPath();

let arduinoCliPath;
let ch341DriverInstallerPath;
setupExecutables();

async function installCore(core) {
    const installCoreParams = ["core", "install", core];
    console.log(await tryRunArduinoCli(installCoreParams));
}

async function installLib(library) {
    const installLibParams = ["lib", "install", library];
    console.log(await tryRunArduinoCli(installLibParams));
}

function writeCodeToCompileLocation(code) {
    const userDataPath = app.getPath('userData');
    const sketchFolder = path.join(userDataPath, 'sketch');
    if (!fs.existsSync(sketchFolder)) {
        fs.mkdirSync(sketchFolder);
    }
    const sketchPath = path.join(sketchFolder, 'sketch.ino');
    fs.writeFileSync(sketchPath, code);
    return sketchPath;
}

async function verifyInstalledCoreAsync(event, name, core) {
    const checkCoreParams = ["core", "list", "--format", "json"];
    const installedCores = JSON.parse(await tryRunArduinoCli(checkCoreParams));
    const isRequiredCoreInstalled = installedCores.map(v => v.ID).includes(core);
    if (isRequiredCoreInstalled) {
        console.log("Required core already installed");
        return;
    };
    const installingCoreMessage = { event: "PREPARING_COMPILATION_ENVIRONMENT", message: `Installing Arduino Core for ${name}` };
    event.sender.send('backend-message', installingCoreMessage);
    await installCore(core);
}

async function verifyInstalledLibsAsync(event, name, libs) {
    const checkLibsParams = ["lib", "list", "--format", "json"];
    const installedLibs = JSON.parse(await tryRunArduinoCli(checkLibsParams));
    const missingLibs = libs.filter(requiredLib => !installedLibs.map(l => l.library.real_name).includes(requiredLib));
    if (!missingLibs.length) {
        console.log("All required libraries already installed");
        return;
    }

    const installingLibsMessage = { event: "PREPARING_COMPILATION_ENVIRONMENT", message: `Installing Leaphy Libraries for ${name}` };
    event.sender.send('backend-message', installingLibsMessage);

    missingLibs.forEach(async missingLib => {
        await installLib(missingLib);
    });
}

ipcMain.on('verify-installation', async (event, payload) => {
    console.log('Verify Installation command received');
    const checkingPrerequisitesMessage = { event: "PREPARING_COMPILATION_ENVIRONMENT", message: `Checking prerequisites for ${payload.name}` };
    event.sender.send('backend-message', checkingPrerequisitesMessage);

    const updateCoreIndexParams = ["core", "update-index"];
    console.log(await tryRunArduinoCli(updateCoreIndexParams));
    const updateLibIndexParams = ["lib", "update-index"];
    console.log(await tryRunArduinoCli(updateLibIndexParams));

    await verifyInstalledCoreAsync(event, payload.name, payload.core);
    await verifyInstalledLibsAsync(event, payload.name, payload.libs);

    const platform = os.platform;
    if (platform == "win32") {
        const allDrivers = await tryRunExecutableAsync("driverquery");
        const isCH340DriverInstalled = allDrivers.indexOf("CH341SER_A64") > -1;
        if(!isCH340DriverInstalled){
            const driverInstallationRequiredMessage =  { event: "DRIVER_INSTALLATION_REQUIRED", message: "USB Driver installation is needed"};
            event.sender.send('backend-message', driverInstallationRequiredMessage);
            return;    
        }
    }

    const installationVerifiedMessage = { event: "INSTALLATION_VERIFIED", message: "All prerequisites for this robot have been installed" };
    event.sender.send('backend-message', installationVerifiedMessage);
});

ipcMain.on('install-usb-driver', async (event, payload) => {
    console.log('Install USB Driver command received');
    // Only do this for windows
    const platform = os.platform;
    if (platform != "win32") return;

    switch (payload.fqbn) {
        case 'arduino:avr:uno':
            console.log(await tryRunExecutableAsync(ch341DriverInstallerPath, []));
            break;
        default:
            break;
    }

    const installationVerifiedMessage = { event: "INSTALLATION_VERIFIED", message: "All prerequisites for this robot have been installed" };
    event.sender.send('backend-message', installationVerifiedMessage);
});


ipcMain.on('compile', async (event, payload) => {
    console.log('Compile command received');
    const sketchPath = writeCodeToCompileLocation(payload.code);
    const compileParams = ["compile", "--fqbn", payload.fqbn, sketchPath];
    const compilingMessage = { event: "COMPILATION_STARTED", message: "Compiling..." };
    event.sender.send('backend-message', compilingMessage);
    try {
        await tryRunArduinoCli(compileParams);
    } catch (error) {
        compilationFailedMessage = { event: "COMPILATION_FAILED", message: "Compilation error" };
        event.sender.send('backend-message', compilationFailedMessage);
        return;
    }

    const compilationCompleteMessage = { event: "COMPILATION_COMPLETE", payload: sketchPath };
    event.sender.send('backend-message', compilationCompleteMessage);
});

ipcMain.on('update-device', async (event, payload) => {
    console.log('Update Device command received');
    const updatingMessage = { event: "UPDATE_STARTED", message: "Updating robot..." };
    event.sender.send('backend-message', updatingMessage);
    const uploadParams = ["upload", "-b", payload.fqbn, "-p", payload.address, "-i", `${payload.sketchPath}.${payload.fqbn.split(":").join(".")}.${payload.ext}`];
    try {
        await tryRunArduinoCli(uploadParams);
    } catch (error) {
        unsuccesfulUploadMessage = { event: "UPDATE_FAILED", message: "Uploading compiled sketch failed", payload: payload };
        event.sender.send('backend-message', unsuccesfulUploadMessage);
        return;
    }

    const updateCompleteMessage = { event: "UPDATE_COMPLETE", message: "Robot is ready for next sketch", payload: payload };
    event.sender.send('backend-message', updateCompleteMessage);
});

ipcMain.on('get-serial-devices', async (event) => {
    console.log('Get Serial Devices command received');
    const updateIndexParams = ["core", "update-index"];
    console.log(await tryRunArduinoCli(updateIndexParams));

    const listBoardsParams = ["board", "list", "--format", "json"];
    const connectedDevices = JSON.parse(await tryRunArduinoCli(listBoardsParams));
    const eligibleBoards = connectedDevices.filter(device => device.protocol_label == "Serial Port (USB)");
    let message;
    if (!eligibleBoards.length) {
        message = { event: "NO_DEVICES_FOUND", message: "No connected robots found" };
    } else {
        message = { event: "DEVICES_FOUND", payload: eligibleBoards };
    }
    event.sender.send('backend-message', message);
});

ipcMain.on('save-workspace', async (event, payload) => {
    console.log("Save Workspace command received");
    fs.writeFileSync(payload.projectFilePath, payload.workspaceXml);
    const message = { event: "WORKSPACE_SAVED", payload: payload.projectFilePath };
    event.sender.send('backend-message', message);
});

ipcMain.on('save-workspace-as', async (event, payload) => {
    console.log("Save Workspace As command received");
    const saveAsOptions = {
        filters: [
            { name: `${payload.robotType.id} files`, extensions: [payload.robotType.id] }
        ]
    }
    if (payload.projectFilePath) {
        saveAsOptions.defaultPath = payload.projectFilePath;
    }
    const response = await dialog.showSaveDialog(saveAsOptions);
    if (response.canceled) {
        const message = { event: "WORKSPACE_SAVE_CANCELLED", message: "Workspace not saved" };
        event.sender.send('backend-message', message);
        return;
    }
    fs.writeFileSync(response.filePath, payload.workspaceXml);
    const message = { event: "WORKSPACE_SAVED", payload: response.filePath };
    event.sender.send('backend-message', message);
});

ipcMain.on('restore-workspace', async (event, robotType) => {
    console.log("Restore Workspace command received");
    const openDialogOptions = {
        filters: [
            { name: `${robotType.id} files`, extensions: [robotType.id] }
        ]
    }
    const response = await dialog.showOpenDialog(openDialogOptions);
    if (response.canceled) {
        const message = { event: "WORKSPACE_RESTORE_CANCELLED", message: "Workspace restore cancelled" };
        event.sender.send('backend-message', message);
        return;
    }
    const workspaceXml = fs.readFileSync(response.filePaths[0], "utf8");
    const payload = { projectFilePath: response.filePaths[0], workspaceXml };
    const message = { event: "WORKSPACE_RESTORING", payload: payload };
    event.sender.send('backend-message', message);
});

async function tryRunArduinoCli(params) {
    return await tryRunExecutableAsync(arduinoCliPath, params);
}

async function tryRunExecutableAsync(path, params) {
    try {
        const { stdout, stderr } = await runExecutableAsync(path, params);
        if (stderr) {
            console.log('stderr:', stderr);
        }
        return stdout;
    } catch (e) {
        console.error(e);
        throw (e);
    }
}

function setupExecutables() {
    let platformFolder;
    let arduino_cli;
    let ch341_driver_installer;
    const platform = os.platform;
    if (platform == "win32") {
        platformFolder = "win32";
        arduino_cli = "arduino-cli.exe";
        ch341_driver_installer = "CH341SER.EXE";
    } else if (platform == "darwin") {
        platformFolder = "darwin";
        arduino_cli = "arduino-cli";
        ch341_driver_installer = "NA";
    }
    arduinoCliPath = path.join(app.getAppPath(), 'lib', platformFolder, 'arduino_cli', arduino_cli);
    ch341DriverInstallerPath = path.join(app.getAppPath(), 'lib', platformFolder, 'ch341_driver_installer', ch341_driver_installer);
}

function handleSquirrelEvent() {
    if (process.argv.length === 1) {
        return false;
    }
    console.log("Handling Squirrel Event");

    const ChildProcess = require('child_process');

    const appFolder = path.resolve(process.execPath, '..');
    const rootAtomFolder = path.resolve(appFolder, '..');
    const updateDotExe = path.resolve(path.join(rootAtomFolder, 'Update.exe'));
    const exeName = path.basename(process.execPath);

    const spawn = function (command, args) {
        let spawnedProcess, error;

        try {
            spawnedProcess = ChildProcess.spawn(command, args, { detached: true });
        } catch (error) { }

        return spawnedProcess;
    };

    const spawnUpdate = function (args) {
        return spawn(updateDotExe, args);
    };

    const squirrelEvent = process.argv[1];
    switch (squirrelEvent) {
        case '--squirrel-install':
        case '--squirrel-updated':
            // Optionally do things such as:
            // - Add your .exe to the PATH
            // - Write to the registry for things like file associations and
            //   explorer context menus

            // Install desktop and start menu shortcuts
            spawnUpdate(['--createShortcut', exeName]);

            setTimeout(app.quit, 1000);
            return true;

        case '--squirrel-uninstall':
            // Undo anything you did in the --squirrel-install and
            // --squirrel-updated handlers

            // Remove desktop and start menu shortcuts
            spawnUpdate(['--removeShortcut', exeName]);

            setTimeout(app.quit, 1000);
            return true;

        case '--squirrel-obsolete':
            // This is called on the outgoing version of your app before
            // we update to the new version - it's the opposite of
            // --squirrel-updated

            app.quit();
            return true;
    }
};

